import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import DOMPurify from "isomorphic-dompurify";
import { decrypt } from "@/lib/crypto";
import type { MailAccount } from "@/lib/db/schema";
import { saveToSentFolder, type AccountLike } from "@/lib/imap";
import {
  autocryptHeader,
  encryptMimeMessage,
  ensureAccountPgpKey,
  prependHeaders,
  publicKeyFilename,
  readPublicKey,
  signMimeMessage,
  type PgpAccountLike,
} from "@/lib/pgp";
import { resolveRecipientKeys, type ResolvedKey } from "@/lib/pgp-keyring";
import { parseRecipients } from "@/lib/allowlist";

export type SmtpAccountLike = Pick<
  MailAccount,
  | "smtpHost"
  | "smtpPort"
  | "smtpSecure"
  | "smtpUser"
  | "smtpPasswordEnc"
  | "email"
  | "fromName"
  | "signatureHtml"
  | "pgpSignByDefault"
  | "pgpAttachPublicKey"
  | "pgpAutoEncrypt"
> &
  AccountLike &
  PgpAccountLike;

/**
 * Providers whose SMTP transparently writes the message to the user's Sent
 * folder — appending via IMAP on top would create duplicates. Every other
 * provider (Outlook, iCloud, Fastmail, OVH, self-hosted…) requires the
 * IMAP APPEND to make the sent message visible in the Sent folder.
 */
function smtpAutoSavesToSent(host: string): boolean {
  const h = host.toLowerCase();
  return h === "smtp.gmail.com" || h.endsWith(".gmail.com");
}

function buildFromAddress(acc: SmtpAccountLike): string | { name: string; address: string } {
  const name = acc.fromName?.trim();
  if (!name) return acc.email;
  return { name, address: acc.email };
}

function buildTransport(acc: SmtpAccountLike) {
  return nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: {
      user: acc.smtpUser,
      pass: decrypt(acc.smtpPasswordEnc),
    },
  });
}

export async function testSmtpConnection(acc: SmtpAccountLike): Promise<void> {
  const transport = buildTransport(acc);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export interface OutgoingAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string;
  contentId?: string;
  isInline?: boolean;
}

export interface SendMailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  includeSignature?: boolean;
  attachments?: OutgoingAttachment[];
  /**
   * Override the automatic Sent-folder detection. true → always APPEND,
   * false → never APPEND. When omitted, we APPEND for every provider except
   * Gmail (which saves to Sent through its SMTP on its own).
   */
  saveToSent?: boolean;
  /** Sign as PGP/MIME. Falls back to the account's `pgpSignByDefault`. */
  pgpSign?: boolean;
  /** Attach the account's public key. Falls back to `pgpAttachPublicKey`. */
  attachPublicKey?: boolean;
  /**
   * true → encrypt or fail (looking up missing keys via WKD), false → never
   * encrypt, undefined → encrypt when the account has `pgpAutoEncrypt` and
   * every recipient already has a key.
   */
  encrypt?: boolean;
}

export interface SendMailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  savedToSent: {
    attempted: boolean;
    ok: boolean;
    folder?: string | null;
    error?: string;
    skippedReason?: string;
  };
  pgp: {
    signed: boolean;
    encrypted: boolean;
    /** Recipients the message was encrypted to (the sender's own key is always added). */
    encryptedTo: string[];
    /** Why an automatic encryption did not happen, if it did not. */
    notEncryptedReason?: string;
    publicKeyAttached: boolean;
    fingerprint: string | null;
  };
}

function safeSignature(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "target", "rel", "width", "height"],
  });
}

function appendSignature(
  acc: SmtpAccountLike,
  input: SendMailInput,
): { text?: string; html?: string } {
  const sig = acc.signatureHtml;
  if (!input.includeSignature || !sig) {
    return { text: input.text, html: input.html };
  }
  const safeSig = safeSignature(sig);
  let html = input.html;
  if (html) {
    html = `${html}<br/><br/>${safeSig}`;
  } else if (input.text) {
    html = `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(input.text)}</pre><br/><br/>${safeSig}`;
  } else {
    html = safeSig;
  }
  return { text: input.text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRawMime(
  mailOptions: Parameters<typeof nodemailer.createTransport>[0] extends never
    ? never
    : Parameters<nodemailer.Transporter["sendMail"]>[0],
): Promise<{ raw: Buffer; envelope: { from: string; to: string[] }; messageId: string }> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composer = new MailComposer(mailOptions as any);
    const node = composer.compile();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = (node as any).getEnvelope();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageId: string = (node as any).messageId();
    node.build((err: Error | null, buf: Buffer) => {
      if (err) reject(err);
      else resolve({ raw: buf, envelope, messageId });
    });
  });
}

export async function sendMail(
  acc: SmtpAccountLike,
  input: SendMailInput,
): Promise<SendMailResult> {
  const transport = buildTransport(acc);
  try {
    const { text, html } = appendSignature(acc, input);
    const pgpSign = input.pgpSign ?? acc.pgpSignByDefault;
    const attachPublicKey = input.attachPublicKey ?? acc.pgpAttachPublicKey;

    // Decide on encryption before anything is composed: a demanded encryption
    // that cannot happen must fail the send, never fall back to clear text.
    const toCc = [...parseRecipients(input.to), ...parseRecipients(input.cc)];
    const bccList = parseRecipients(input.bcc);
    const encryptMode =
      input.encrypt === true
        ? "required"
        : input.encrypt === false
          ? "off"
          : acc.pgpAutoEncrypt
            ? "auto"
            : "off";
    let recipientKeys: Map<string, ResolvedKey> | null = null;
    let notEncryptedReason: string | undefined;
    if (encryptMode !== "off") {
      const { keys, missing } = await resolveRecipientKeys(acc.userId, [...toCc, ...bccList], {
        wkd: encryptMode === "required",
      });
      if (missing.length === 0) {
        recipientKeys = keys;
      } else if (encryptMode === "required") {
        throw new Error(
          `Cannot encrypt: no usable PGP key for ${missing.join(", ")}. Nothing was sent.`,
        );
      } else {
        notEncryptedReason = `no PGP key for ${missing.join(", ")}`;
      }
    } else {
      notEncryptedReason = input.encrypt === false ? "encrypt=false" : "auto-encrypt is off";
    }
    const encrypt = recipientKeys !== null;

    const pgpKey =
      pgpSign || attachPublicKey || encrypt ? await ensureAccountPgpKey(acc) : null;

    const attachments: NonNullable<nodemailer.SendMailOptions["attachments"]> =
      input.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
        cid: a.contentId,
        contentDisposition: a.isInline ? ("inline" as const) : ("attachment" as const),
      })) ?? [];
    if (pgpKey && attachPublicKey) {
      attachments.push({
        filename: publicKeyFilename(pgpKey.fingerprint),
        content: pgpKey.publicKey,
        contentType: "application/pgp-keys",
        contentDisposition: "attachment",
      });
    }

    const mailOptions: nodemailer.SendMailOptions = {
      from: buildFromAddress(acc),
      to: input.to.join(", "),
      cc: input.cc?.join(", "),
      bcc: input.bcc?.join(", "),
      subject: input.subject,
      text,
      html,
      inReplyTo: input.inReplyTo,
      references: input.references?.join(" "),
      attachments: attachments.length ? attachments : undefined,
      // A signature covers the exact bytes, so keep the signed part 7-bit:
      // quoted-printable also protects trailing whitespace and long lines
      // from being rewritten by relays on the way.
      textEncoding: pgpSign || encrypt ? "quoted-printable" : undefined,
    };

    // Compose the raw MIME once so we can both feed it to SMTP and APPEND
    // the exact same bytes to IMAP — guarantees the Sent copy matches what
    // the recipient got on the wire (same Message-ID, same Date, same
    // multipart boundaries).
    const composed = await buildRawMime(mailOptions);
    const { envelope, messageId } = composed;
    const autocrypt =
      pgpKey && attachPublicKey ? await autocryptHeader(acc.email, pgpKey.publicKey) : null;
    const base = prependHeaders(composed.raw, autocrypt ? [autocrypt] : []);
    const selfKey = pgpKey && encrypt ? await readPublicKey(pgpKey.publicKey) : null;

    const wrap = async (addresses: string[]): Promise<Buffer> => {
      if (encrypt && pgpKey && selfKey) {
        const keys = addresses.map((a) => recipientKeys!.get(a)!.key);
        return encryptMimeMessage(base, [...keys, selfKey], pgpSign ? pgpKey.privateKeyEnc : null);
      }
      if (pgpSign && pgpKey) return signMimeMessage(base, pgpKey.privateKeyEnc);
      return base;
    };

    // Encrypting to Bcc keys in the copy everyone gets would reveal the Bcc
    // recipients through the key IDs in it, so each Bcc recipient gets a copy
    // of their own. The To/Cc copy is the one saved to Sent.
    const splitBcc = encrypt && bccList.length > 0;
    const raw = await wrap(splitBcc ? toCc : [...toCc, ...bccList]);
    const accepted: string[] = [];
    const rejected: string[] = [];
    let serverMessageId: string | undefined;
    const deliver = async (env: typeof envelope, bytes: Buffer) => {
      const info = await transport.sendMail({ envelope: env, raw: bytes, messageId });
      serverMessageId ??= info.messageId;
      accepted.push(...((info.accepted as string[]) ?? []));
      rejected.push(...((info.rejected as string[]) ?? []));
    };
    if (!splitBcc) {
      await deliver(envelope, raw);
    } else {
      if (toCc.length) await deliver({ ...envelope, to: toCc }, raw);
      for (const b of bccList) {
        await deliver({ ...envelope, to: [b] }, await wrap([...toCc, b]));
      }
    }

    const shouldAppend =
      input.saveToSent === true
        ? true
        : input.saveToSent === false
          ? false
          : !smtpAutoSavesToSent(acc.smtpHost);

    let savedToSent: SendMailResult["savedToSent"] = {
      attempted: false,
      ok: false,
    };
    if (shouldAppend) {
      const r = await saveToSentFolder(acc, raw);
      savedToSent = {
        attempted: true,
        ok: r.ok,
        folder: r.folder,
        error: r.error,
      };
    } else if (smtpAutoSavesToSent(acc.smtpHost)) {
      savedToSent = {
        attempted: false,
        ok: true,
        skippedReason: "provider auto-saves to Sent via SMTP (Gmail)",
      };
    } else {
      savedToSent = {
        attempted: false,
        ok: false,
        skippedReason: "saveToSent=false",
      };
    }

    return {
      messageId: serverMessageId ?? messageId,
      accepted,
      rejected,
      savedToSent,
      pgp: {
        signed: Boolean(pgpSign && pgpKey),
        encrypted: encrypt,
        encryptedTo: encrypt ? [...toCc, ...bccList] : [],
        notEncryptedReason: encrypt ? undefined : notEncryptedReason,
        publicKeyAttached: Boolean(attachPublicKey && pgpKey),
        fingerprint: pgpKey?.fingerprint ?? null,
      },
    };
  } finally {
    transport.close();
  }
}

export function sanitizeSignatureHtml(html: string): string {
  return safeSignature(html);
}
