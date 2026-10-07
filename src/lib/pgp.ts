import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import * as openpgp from "openpgp";
import { db } from "@/lib/db";
import { mailAccounts, type MailAccount } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

/** What gets stored on `mail_accounts` for an account's OpenPGP identity. */
export interface PgpKeyMaterial {
  /** Armored, unlocked private key, encrypted with the master key. */
  privateKeyEnc: string;
  publicKey: string;
  fingerprint: string;
}

/** Public facts about a key — safe to hand to the UI and to MCP clients. */
export interface PgpKeyInfo {
  fingerprint: string;
  keyId: string;
  userIds: string[];
  algorithm: string;
  createdAt: string;
  expiresAt: string | null;
}

export type PgpAccountLike = Pick<
  MailAccount,
  | "id"
  | "userId"
  | "email"
  | "fromName"
  | "pgpPrivateKeyEnc"
  | "pgpPublicKey"
  | "pgpFingerprint"
>;

async function materialFrom(key: openpgp.PrivateKey): Promise<PgpKeyMaterial> {
  // Fail early on keys that cannot sign (encryption-only subkeys, revoked or
  // expired primaries) instead of at the first send.
  await key.getSigningKey();
  return {
    privateKeyEnc: encrypt(key.armor()),
    publicKey: key.toPublic().armor(),
    fingerprint: key.getFingerprint().toUpperCase(),
  };
}

/** A fresh Ed25519/Curve25519 key (v4, readable by every current OpenPGP client). */
export async function generatePgpKey(email: string, name?: string | null): Promise<PgpKeyMaterial> {
  const { privateKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: name?.trim() || undefined, email }],
    format: "object",
  });
  return materialFrom(privateKey);
}

/**
 * Import an armored private key. A passphrase-protected key is unlocked once
 * here and stored without its passphrase — at rest it is protected by the
 * master key, the same way the IMAP/SMTP passwords are.
 */
export async function importPgpKey(
  armoredKey: string,
  passphrase?: string,
): Promise<PgpKeyMaterial> {
  let key: openpgp.PrivateKey;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armoredKey.trim() });
  } catch {
    throw new Error("Not an armored OpenPGP private key (-----BEGIN PGP PRIVATE KEY BLOCK-----)");
  }
  if (!key.isDecrypted()) {
    if (!passphrase) throw new Error("This key is passphrase-protected — enter the passphrase");
    try {
      key = await openpgp.decryptKey({ privateKey: key, passphrase });
    } catch {
      throw new Error("Wrong passphrase for this key");
    }
  }
  try {
    return await materialFrom(key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`This key cannot be used for signing: ${msg}`);
  }
}

export async function describePublicKey(armoredKey: string): Promise<PgpKeyInfo> {
  const key = await openpgp.readKey({ armoredKey });
  const expiry = await key.getExpirationTime();
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    keyId: key.getKeyID().toHex().toUpperCase(),
    userIds: key.getUserIDs(),
    algorithm: describeAlgorithm(key.getAlgorithmInfo()),
    createdAt: key.getCreationTime().toISOString(),
    expiresAt: expiry instanceof Date ? expiry.toISOString() : null,
  };
}

function describeAlgorithm(info: { algorithm: string; bits?: number; curve?: string }): string {
  if (info.curve) return `${info.algorithm} (${info.curve})`;
  if (info.bits) return `${info.algorithm} ${info.bits}`;
  return info.algorithm;
}

/**
 * Return the account's key material, generating and storing a key when the
 * account has none yet. The write only lands on a row that still has no key,
 * so two concurrent first sends end up using the same key.
 */
export async function ensureAccountPgpKey(acc: PgpAccountLike): Promise<PgpKeyMaterial> {
  if (acc.pgpPrivateKeyEnc && acc.pgpPublicKey && acc.pgpFingerprint) {
    return {
      privateKeyEnc: acc.pgpPrivateKeyEnc,
      publicKey: acc.pgpPublicKey,
      fingerprint: acc.pgpFingerprint,
    };
  }
  const material = await generatePgpKey(acc.email, acc.fromName);
  const [stored] = await db
    .update(mailAccounts)
    .set({
      pgpPrivateKeyEnc: material.privateKeyEnc,
      pgpPublicKey: material.publicKey,
      pgpFingerprint: material.fingerprint,
    })
    .where(
      and(
        eq(mailAccounts.id, acc.id),
        eq(mailAccounts.userId, acc.userId),
        isNull(mailAccounts.pgpPrivateKeyEnc),
      ),
    )
    .returning({ id: mailAccounts.id });
  if (stored) return material;

  const [current] = await db
    .select({
      privateKeyEnc: mailAccounts.pgpPrivateKeyEnc,
      publicKey: mailAccounts.pgpPublicKey,
      fingerprint: mailAccounts.pgpFingerprint,
    })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, acc.id), eq(mailAccounts.userId, acc.userId)))
    .limit(1);
  if (!current?.privateKeyEnc || !current.publicKey || !current.fingerprint) {
    throw new Error(`Account ${acc.id} not found while provisioning its PGP key`);
  }
  return {
    privateKeyEnc: current.privateKeyEnc,
    publicKey: current.publicKey,
    fingerprint: current.fingerprint,
  };
}

/** Thunderbird's naming, so recipients' clients recognise the file as a key. */
export function publicKeyFilename(fingerprint: string): string {
  return `OpenPGP_0x${fingerprint.slice(-16).toUpperCase()}.asc`;
}

/**
 * Turn a composed RFC 5322 message into a PGP/MIME signed one (RFC 3156):
 *
 *   multipart/signed; protocol="application/pgp-signature"
 *     ├─ the original body with its Content-* headers   ← signed bytes
 *     └─ application/pgp-signature (detached, armored)
 *
 * Every non-Content-* header (From, To, Subject, Message-ID, …) stays on the
 * outer message, so the Message-ID and envelope are unchanged. The input must
 * use CRLF line endings and 7-bit safe transfer encodings, which is what
 * nodemailer produces with `textEncoding: "quoted-printable"`.
 */
export async function signMimeMessage(raw: Buffer, privateKeyEnc: string): Promise<Buffer> {
  // latin1 maps bytes 1:1, so slicing the string and converting back never
  // alters a byte even if something 8-bit slipped through.
  // RFC 3156 signs the canonical (CRLF) form. nodemailer keeps bare LFs from
  // the body text in quoted-printable parts and leaves it to the SMTP data
  // stream to fix them up — after we signed, which would break the signature.
  const source = raw.toString("latin1").replace(/\r?\n/g, "\r\n");
  const split = source.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("cannot sign: message has no header/body separator");

  const fields = unfoldHeaderFields(source.slice(0, split));
  const body = source.slice(split + 4);
  const contentFields = fields.filter((f) => /^content-/i.test(f));
  const outerFields = fields.filter((f) => !/^content-/i.test(f));
  if (!contentFields.some((f) => /^content-type:/i.test(f))) {
    contentFields.unshift("Content-Type: text/plain; charset=us-ascii");
  }

  const signedPart = `${contentFields.join("\r\n")}\r\n\r\n${body}`;
  const signingKey = await openpgp.readPrivateKey({ armoredKey: decrypt(privateKeyEnc) });
  const armoredSignature = (await openpgp.sign({
    message: await openpgp.createMessage({ binary: Buffer.from(signedPart, "latin1") }),
    signingKeys: signingKey,
    detached: true,
    format: "armored",
  })) as string;

  const signature = await openpgp.readSignature({ armoredSignature });
  const hashId = signature.packets[0]?.hashAlgorithm;
  const hashName =
    Object.entries(openpgp.enums.hash).find(([, value]) => value === hashId)?.[0] ?? "sha256";
  const micalg = `pgp-${hashName.toLowerCase()}`;

  let boundary: string;
  do {
    boundary = `----PGP-${randomBytes(12).toString("hex")}`;
  } while (signedPart.includes(boundary));

  const out = [
    ...outerFields,
    `Content-Type: multipart/signed; micalg=${micalg};\r\n protocol="application/pgp-signature";\r\n boundary="${boundary}"`,
    "",
    "This is an OpenPGP/MIME signed message (RFC 4880 and 3156)",
    `--${boundary}`,
    signedPart,
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="OpenPGP_signature.asc"',
    "Content-Description: OpenPGP digital signature",
    'Content-Disposition: attachment; filename="OpenPGP_signature.asc"',
    "",
    armoredSignature.replace(/\r?\n/g, "\r\n").replace(/\r\n$/, ""),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(out, "latin1");
}

/** Split a header block into whole fields, keeping folded continuation lines attached. */
function unfoldHeaderFields(block: string): string[] {
  const fields: string[] = [];
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1] += `\r\n${line}`;
    } else if (line) {
      fields.push(line);
    }
  }
  return fields;
}
