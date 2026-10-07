import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import * as openpgp from "openpgp";
import type { MailAccount, PgpKeySource } from "@/lib/db/schema";
import { accountDecryptionKeys } from "@/lib/pgp";
import { importKey, normalizeEmail, parsePublicKeys, senderKey } from "@/lib/pgp-keyring";

export type PgpReadAccount = Pick<MailAccount, "userId" | "pgpPrivateKeyEnc" | "pgpPreviousKeysEnc">;

export type SignatureStatus =
  /** Verified against the key on file for the sender's address. */
  | "valid"
  /** The signature does not match the content or the key — treat the message as forged or altered. */
  | "invalid"
  /** Signed, but with a key we do not have for the sender's address. Unverified. */
  | "unknown_key";

export interface PgpSignatureInfo {
  status: SignatureStatus;
  /** Long key ID the signature claims (hex). */
  keyId: string | null;
  /** Fingerprint of the key that verified it (status "valid" only). */
  fingerprint: string | null;
  /** Where the sender's key came from, when we had one. */
  keySource: PgpKeySource | "account" | null;
  error?: string;
}

export interface PgpReadStatus {
  /** The message (or its text body) was OpenPGP-encrypted. */
  encrypted: boolean;
  /** Content below is the decrypted plaintext. */
  decrypted: boolean;
  decryptionError?: string;
  signature: PgpSignatureInfo | null;
  /** A key for the sender was added to the keyring from this message (trust on first use). */
  learnedKey?: { email: string; fingerprint: string; from: "autocrypt" | "attachment" };
  /** The message offers a different key than the one on file for the sender. Nothing was changed. */
  keyConflict?: { email: string; offeredFingerprint: string; storedFingerprint: string };
}

export interface OpenedMessage {
  /** Outer headers (subject, from, to, ids …) — always from the envelope message. */
  parsed: ParsedMail;
  /** Content, decrypted when possible. */
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  pgp: PgpReadStatus | null;
}

const PGP_MESSAGE = "-----BEGIN PGP MESSAGE-----";
const PGP_SIGNED = "-----BEGIN PGP SIGNED MESSAGE-----";

function contentType(parsed: ParsedMail): { value: string; params: Record<string, string> } {
  const ct = parsed.headers.get("content-type") as
    | { value?: string; params?: Record<string, string> }
    | string
    | undefined;
  if (!ct) return { value: "text/plain", params: {} };
  if (typeof ct === "string") return { value: ct.split(";")[0].trim().toLowerCase(), params: {} };
  return { value: (ct.value ?? "").toLowerCase(), params: ct.params ?? {} };
}

function attachmentText(a: Attachment): string {
  const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content as Uint8Array);
  return buf.toString("utf8");
}

/** Parts that are PGP/MIME plumbing rather than something the sender attached. */
function isPgpPlumbing(a: Attachment): boolean {
  const ct = (a.contentType ?? "").toLowerCase();
  return (
    ct === "application/pgp-encrypted" ||
    ct === "application/pgp-signature" ||
    (ct === "application/octet-stream" && attachmentText(a).includes(PGP_MESSAGE))
  );
}

/**
 * The bytes of the first body part of a multipart entity, exactly as they
 * appear between the first delimiter and the next — what a multipart/signed
 * signature covers. Line endings are canonicalised to CRLF first.
 */
function firstPartBytes(raw: Buffer, boundary: string): Buffer | null {
  const source = raw.toString("latin1").replace(/\r?\n/g, "\r\n");
  const split = source.indexOf("\r\n\r\n");
  if (split < 0) return null;
  const body = `\r\n${source.slice(split + 4)}`;
  const open = `\r\n--${boundary}\r\n`;
  const start = body.indexOf(open);
  if (start < 0) return null;
  const from = start + open.length;
  const end = body.indexOf(`\r\n--${boundary}`, from);
  if (end < 0) return null;
  return Buffer.from(body.slice(from, end), "latin1");
}

async function checkSignature(
  sig: { keyID: openpgp.KeyID; verified: Promise<true> },
  verificationKey: { key: openpgp.PublicKey; source: PgpSignatureInfo["keySource"] } | null,
): Promise<PgpSignatureInfo> {
  const keyId = sig.keyID.toHex().toUpperCase();
  const known =
    verificationKey &&
    verificationKey.key.getKeys(sig.keyID).length > 0;
  try {
    await sig.verified;
    return {
      status: known ? "valid" : "unknown_key",
      keyId,
      fingerprint: known ? verificationKey!.key.getFingerprint().toUpperCase() : null,
      keySource: verificationKey?.source ?? null,
    };
  } catch (e) {
    return {
      status: known ? "invalid" : "unknown_key",
      keyId,
      fingerprint: null,
      keySource: verificationKey?.source ?? null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function verifyDetached(
  raw: Buffer,
  parsed: ParsedMail,
  verificationKey: Parameters<typeof checkSignature>[1],
): Promise<PgpSignatureInfo | null> {
  const ct = contentType(parsed);
  if (ct.value !== "multipart/signed" || !ct.params.boundary) return null;
  const sigPart = parsed.attachments.find(
    (a) => (a.contentType ?? "").toLowerCase() === "application/pgp-signature",
  );
  const signed = firstPartBytes(raw, ct.params.boundary);
  if (!sigPart || !signed) return null;
  try {
    const signature = await openpgp.readSignature({ armoredSignature: attachmentText(sigPart) });
    const result = await openpgp.verify({
      message: await openpgp.createMessage({ binary: signed }),
      signature,
      verificationKeys: verificationKey ? [verificationKey.key] : [],
    });
    return result.signatures[0] ? checkSignature(result.signatures[0], verificationKey) : null;
  } catch (e) {
    return {
      status: "invalid",
      keyId: null,
      fingerprint: null,
      keySource: verificationKey?.source ?? null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** `Autocrypt: addr=…; keydata=…` from the raw header lines, when it names `sender`. */
function autocryptKeydata(parsed: ParsedMail, sender: string): Uint8Array | null {
  for (const h of parsed.headerLines ?? []) {
    if (h.key !== "autocrypt") continue;
    const value = h.line.replace(/^autocrypt:\s*/i, "").replace(/\r?\n[ \t]+/g, " ");
    const attrs = new Map<string, string>();
    for (const part of value.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) attrs.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    if (normalizeEmail(attrs.get("addr") ?? "") !== sender) continue;
    const keydata = attrs.get("keydata")?.replace(/\s+/g, "");
    if (keydata) return new Uint8Array(Buffer.from(keydata, "base64"));
  }
  return null;
}

/**
 * Trust on first use: store a key the sender offers for their own address when
 * the keyring has none for it yet. A different key than the one on file is
 * reported, never stored — replacing keys is the owner's call in the web UI.
 */
async function learnSenderKey(
  acc: PgpReadAccount,
  parsed: ParsedMail,
  attachments: Attachment[],
  sender: string,
  status: PgpReadStatus,
): Promise<void> {
  const offers: Array<{ data: string | Uint8Array; from: "autocrypt" | "attachment" }> = [];
  const ac = autocryptKeydata(parsed, sender);
  if (ac) offers.push({ data: ac, from: "autocrypt" });
  for (const a of attachments) {
    const ct = (a.contentType ?? "").toLowerCase();
    if (ct === "application/pgp-keys" || /\.asc$/i.test(a.filename ?? "")) {
      const text = attachmentText(a);
      if (text.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
        offers.push({ data: text, from: "attachment" });
      }
    }
  }
  if (!offers.length) return;
  // The user's own addresses use their account keys; never shadow those.
  if ((await senderKey(acc.userId, sender))?.source === "account") return;
  for (const offer of offers) {
    try {
      const keys = await parsePublicKeys(offer.data);
      for (const key of keys) {
        const [result] = await importKey(acc.userId, key, offer.from, { onlyEmail: sender });
        if (result?.status === "added") {
          status.learnedKey = { email: sender, fingerprint: result.fingerprint, from: offer.from };
          return;
        }
        if (result?.status === "conflict" && result.existingFingerprint) {
          status.keyConflict = {
            email: sender,
            offeredFingerprint: result.fingerprint,
            storedFingerprint: result.existingFingerprint,
          };
        }
        if (result) return;
      }
    } catch {
      // A key without a user ID for the sender, or garbage — ignore it.
    }
  }
}

/**
 * Parse a raw message and, when it is OpenPGP-protected, decrypt it with the
 * account's keys and verify its signature against the sender's key. Plain
 * messages come back as mailparser parses them, with `pgp: null`.
 */
export async function openMessage(
  acc: PgpReadAccount,
  source: Buffer,
  opts: { learnKeys?: boolean } = {},
): Promise<OpenedMessage> {
  const parsed = await simpleParser(source);
  const sender = normalizeEmail(parsed.from?.value?.[0]?.address ?? "");
  const ct = contentType(parsed);

  let text = parsed.text ?? null;
  let html = typeof parsed.html === "string" ? parsed.html : null;
  let attachments = parsed.attachments ?? [];

  const pgpMime =
    ct.value === "multipart/encrypted" &&
    (ct.params.protocol ?? "").toLowerCase() === "application/pgp-encrypted";
  const inlineEncrypted = !pgpMime && (text ?? "").includes(PGP_MESSAGE);
  const inlineSigned = !pgpMime && !inlineEncrypted && (text ?? "").includes(PGP_SIGNED);
  const detachedSigned = ct.value === "multipart/signed";

  if (!pgpMime && !inlineEncrypted && !inlineSigned && !detachedSigned) {
    const status: PgpReadStatus = { encrypted: false, decrypted: false, signature: null };
    if (opts.learnKeys && sender) await learnSenderKey(acc, parsed, attachments, sender, status);
    const changed = status.learnedKey || status.keyConflict;
    return { parsed, text, html, attachments, pgp: changed ? status : null };
  }

  const status: PgpReadStatus = {
    encrypted: pgpMime || inlineEncrypted,
    decrypted: false,
    signature: null,
  };

  // Learn from the clear-text envelope first so a signature in this very
  // message can be checked against the key it carries.
  if (opts.learnKeys && sender) await learnSenderKey(acc, parsed, attachments, sender, status);
  const verificationKey = sender ? await senderKey(acc.userId, sender) : null;

  if (pgpMime || inlineEncrypted) {
    const armored = pgpMime
      ? attachments.map(attachmentText).find((t) => t.includes(PGP_MESSAGE))
      : text!.slice(text!.indexOf(PGP_MESSAGE));
    const decryptionKeys = await accountDecryptionKeys(acc);
    if (!armored) {
      status.decryptionError = "encrypted part not found";
    } else if (!decryptionKeys.length) {
      status.decryptionError = "this account has no private key";
    } else {
      try {
        const result = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: armored }),
          decryptionKeys,
          verificationKeys: verificationKey ? [verificationKey.key] : [],
          format: "binary",
        });
        const plain = Buffer.from(result.data as Uint8Array);
        status.decrypted = true;
        if (result.signatures[0]) {
          status.signature = await checkSignature(result.signatures[0], verificationKey);
        }
        if (pgpMime) {
          const inner = await simpleParser(plain);
          text = inner.text ?? null;
          html = typeof inner.html === "string" ? inner.html : null;
          attachments = inner.attachments ?? [];
          // Sign-then-encrypt (Enigmail style): the plaintext is itself multipart/signed.
          status.signature ??= await verifyDetached(plain, inner, verificationKey);
          if (opts.learnKeys && sender && !status.learnedKey && !status.keyConflict) {
            await learnSenderKey(acc, inner, attachments, sender, status);
          }
        } else {
          text = plain.toString("utf8");
          html = null;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.decryptionError = /decryption key|session key/i.test(msg)
          ? "not encrypted to any key of this account"
          : msg;
      }
    }
    if (!status.decrypted) {
      text = null;
      html = null;
    }
  } else if (detachedSigned) {
    status.signature = await verifyDetached(source, parsed, verificationKey);
  } else if (inlineSigned) {
    try {
      const cleartext = await openpgp.readCleartextMessage({
        cleartextMessage: text!.slice(text!.indexOf(PGP_SIGNED)),
      });
      const result = await openpgp.verify({
        message: cleartext,
        verificationKeys: verificationKey ? [verificationKey.key] : [],
      });
      if (result.signatures[0]) {
        status.signature = await checkSignature(result.signatures[0], verificationKey);
      }
      text = cleartext.getText();
    } catch (e) {
      status.signature = {
        status: "invalid",
        keyId: null,
        fingerprint: null,
        keySource: verificationKey?.source ?? null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return {
    parsed,
    text,
    html,
    attachments: attachments.filter((a) => !isPgpPlumbing(a)),
    pgp: status,
  };
}
