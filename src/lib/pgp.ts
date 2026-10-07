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
 * Split a composed RFC 5322 message into the headers that stay on the outer
 * message (From, To, Subject, Message-ID, …) and the MIME entity that carries
 * the content (its Content-* headers plus the body). The entity is returned in
 * canonical CRLF form, which is what RFC 3156 signs and encrypts.
 */
function splitMessage(raw: Buffer): { outerFields: string[]; entity: string } {
  // latin1 maps bytes 1:1, so slicing the string and converting back never
  // alters a byte even if something 8-bit slipped through. nodemailer keeps
  // bare LFs from the body text in quoted-printable parts and leaves it to the
  // SMTP data stream to fix them up — after we signed, which would break the
  // signature — so canonicalise here.
  const source = raw.toString("latin1").replace(/\r?\n/g, "\r\n");
  const split = source.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("cannot wrap message: no header/body separator");

  const fields = unfoldHeaderFields(source.slice(0, split));
  const body = source.slice(split + 4);
  const contentFields = fields.filter((f) => /^content-/i.test(f));
  const outerFields = fields.filter((f) => !/^content-/i.test(f));
  if (!contentFields.some((f) => /^content-type:/i.test(f))) {
    contentFields.unshift("Content-Type: text/plain; charset=us-ascii");
  }
  return { outerFields, entity: `${contentFields.join("\r\n")}\r\n\r\n${body}` };
}

function newBoundary(avoid: string): string {
  let boundary: string;
  do {
    boundary = `----PGP-${randomBytes(12).toString("hex")}`;
  } while (avoid.includes(boundary));
  return boundary;
}

function crlf(armored: string): string {
  return armored.replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "");
}

/**
 * Turn a composed RFC 5322 message into a PGP/MIME signed one (RFC 3156 §5):
 *
 *   multipart/signed; protocol="application/pgp-signature"
 *     ├─ the original body with its Content-* headers   ← signed bytes
 *     └─ application/pgp-signature (detached, armored)
 *
 * Every non-Content-* header stays on the outer message, so the Message-ID
 * and envelope are unchanged. The input should use 7-bit safe transfer
 * encodings, which is what nodemailer produces with
 * `textEncoding: "quoted-printable"`.
 */
export async function signMimeMessage(raw: Buffer, privateKeyEnc: string): Promise<Buffer> {
  const { outerFields, entity } = splitMessage(raw);
  const signingKey = await openpgp.readPrivateKey({ armoredKey: decrypt(privateKeyEnc) });
  const armoredSignature = (await openpgp.sign({
    message: await openpgp.createMessage({ binary: Buffer.from(entity, "latin1") }),
    signingKeys: signingKey,
    detached: true,
    format: "armored",
  })) as string;

  const signature = await openpgp.readSignature({ armoredSignature });
  const hashId = signature.packets[0]?.hashAlgorithm;
  const hashName =
    Object.entries(openpgp.enums.hash).find(([, value]) => value === hashId)?.[0] ?? "sha256";
  const micalg = `pgp-${hashName.toLowerCase()}`;
  const boundary = newBoundary(entity);

  const out = [
    ...outerFields,
    `Content-Type: multipart/signed; micalg=${micalg};\r\n protocol="application/pgp-signature";\r\n boundary="${boundary}"`,
    "",
    "This is an OpenPGP/MIME signed message (RFC 4880 and 3156)",
    `--${boundary}`,
    entity,
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="OpenPGP_signature.asc"',
    "Content-Description: OpenPGP digital signature",
    'Content-Disposition: attachment; filename="OpenPGP_signature.asc"',
    "",
    crlf(armoredSignature),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(out, "latin1");
}

/**
 * Turn a composed message into a PGP/MIME encrypted one (RFC 3156 §4), signed
 * and encrypted in one OpenPGP message (§6.2) when a signing key is given:
 *
 *   multipart/encrypted; protocol="application/pgp-encrypted"
 *     ├─ application/pgp-encrypted   "Version: 1"
 *     └─ application/octet-stream    the armored OpenPGP message
 *
 * Only the MIME entity is encrypted — the outer headers, Subject included,
 * travel in clear text.
 */
export async function encryptMimeMessage(
  raw: Buffer,
  encryptionKeys: openpgp.PublicKey[],
  signingKeyEnc: string | null,
): Promise<Buffer> {
  if (!encryptionKeys.length) throw new Error("cannot encrypt: no recipient keys");
  const { outerFields, entity } = splitMessage(raw);
  const signingKeys = signingKeyEnc
    ? await openpgp.readPrivateKey({ armoredKey: decrypt(signingKeyEnc) })
    : undefined;
  const armored = (await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: Buffer.from(entity, "latin1") }),
    encryptionKeys,
    signingKeys,
    format: "armored",
  })) as string;
  const boundary = newBoundary(armored);

  const out = [
    ...outerFields,
    `Content-Type: multipart/encrypted;\r\n protocol="application/pgp-encrypted";\r\n boundary="${boundary}"`,
    "",
    "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
    `--${boundary}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    "",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted message",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    crlf(armored),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(out, "latin1");
}

/**
 * An `Autocrypt:` header line (folded) announcing the account's key, so
 * Thunderbird, K-9/FairEmail, Delta Chat and this server can pick it up and
 * encrypt replies. Returns null when the key has no user ID for `email`.
 */
export async function autocryptHeader(email: string, publicKey: string): Promise<string | null> {
  const key = await openpgp.readKey({ armoredKey: publicKey });
  const addr = email.trim().toLowerCase();
  if (!keyEmails(key).includes(addr)) return null;
  const keydata = Buffer.from(key.write()).toString("base64");
  const lines = keydata.match(/.{1,76}/g) ?? [];
  return `Autocrypt: addr=${addr}; keydata=\r\n ${lines.join("\r\n ")}`;
}

/** Insert extra header fields at the top of a composed message. */
export function prependHeaders(raw: Buffer, fields: string[]): Buffer {
  if (!fields.length) return raw;
  return Buffer.concat([Buffer.from(fields.join("\r\n") + "\r\n", "latin1"), raw]);
}

export async function readPublicKey(armoredKey: string): Promise<openpgp.PublicKey> {
  return openpgp.readKey({ armoredKey }) as Promise<openpgp.PublicKey>;
}

/** Lower-cased e-mail addresses in a key's user IDs. */
export function keyEmails(key: openpgp.Key): string[] {
  const out = new Set<string>();
  for (const uid of key.users) {
    const email = uid.userID?.email?.trim().toLowerCase();
    if (email) out.add(email);
  }
  return [...out];
}

/** The account's current and retired private keys, for decryption. */
export async function accountDecryptionKeys(acc: {
  pgpPrivateKeyEnc: string | null;
  pgpPreviousKeysEnc: string[];
}): Promise<openpgp.PrivateKey[]> {
  const stored = [acc.pgpPrivateKeyEnc, ...acc.pgpPreviousKeysEnc].filter(
    (k): k is string => Boolean(k),
  );
  const keys: openpgp.PrivateKey[] = [];
  for (const enc of stored) {
    try {
      keys.push(await openpgp.readPrivateKey({ armoredKey: decrypt(enc) }));
    } catch {
      // A key that no longer decrypts (master key rotated) only costs us old mail.
    }
  }
  return keys;
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
