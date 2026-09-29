import addressparser from "nodemailer/lib/addressparser";
import { z } from "zod";

/**
 * Per-account recipient allowlist for the human-in-the-loop gate.
 *
 * An entry is either a full address (`jane@example.com`) or a whole domain
 * (`@example.com`). Domains match exactly — `@example.com` does not cover
 * `sub.example.com` or `evil-example.com`. A message skips approval only when
 * EVERY recipient in To, Cc and Bcc is covered; one outsider sends the whole
 * message to the outbox.
 */

export const MAX_ALLOWLIST_ENTRIES = 200;

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+$/;

/** Lowercase, trim, and turn a bare domain (`example.com`) into `@example.com`. */
export function normalizeAllowlistEntry(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v.includes("@")) return `@${v}`;
  return v;
}

export function isValidAllowlistEntry(entry: string): boolean {
  if (entry.startsWith("@")) return DOMAIN_RE.test(entry.slice(1));
  if (!EMAIL_RE.test(entry)) return false;
  return DOMAIN_RE.test(entry.slice(entry.lastIndexOf("@") + 1));
}

export const allowlistSchema = z
  .array(z.string().max(320))
  .max(MAX_ALLOWLIST_ENTRIES)
  .transform((entries) => [
    ...new Set(entries.map(normalizeAllowlistEntry).filter((e) => e !== "@")),
  ])
  .superRefine((entries, ctx) => {
    for (const e of entries) {
      if (!isValidAllowlistEntry(e)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Not an email address or domain: ${e}`,
        });
      }
    }
  });

/**
 * Parse a recipient header the way SMTP will see it. `sendMail` joins each
 * list with ", " before nodemailer parses it, so we parse the same joined
 * string — never the entries one by one — and flatten groups. That way a
 * value like `"a@ok.com, b@elsewhere.com"` or a quote split across two
 * entries cannot hide an extra recipient from the check.
 */
function parseHeader(list: string[] | undefined): string[] | null {
  if (!list || list.length === 0) return [];
  const parsed = addressparser(list.join(", "), { flatten: true }).map((a) =>
    a.address.trim().toLowerCase(),
  );
  // An entry that parses to nothing (or to an empty address) is a sign the
  // header is not what it looks like — refuse to vouch for it.
  if (parsed.length < list.length || parsed.some((a) => !a)) return null;
  return parsed;
}

function isCovered(address: string, allowlist: ReadonlySet<string>): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  return allowlist.has(address) || allowlist.has(address.slice(at));
}

/**
 * True when the allowlist is non-empty and covers every recipient. An empty
 * recipient list, an unparsable field or any uncovered address yields false —
 * the caller then falls back to the normal approval gate.
 */
export function recipientsAllowlisted(
  allowlist: readonly string[] | null | undefined,
  recipients: { to: string[]; cc?: string[]; bcc?: string[] },
): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const set = new Set(allowlist.map(normalizeAllowlistEntry));

  let count = 0;
  for (const header of [recipients.to, recipients.cc, recipients.bcc]) {
    const parsed = parseHeader(header);
    if (parsed === null) return false;
    for (const addr of parsed) {
      if (!isCovered(addr, set)) return false;
      count++;
    }
  }
  return count > 0;
}
