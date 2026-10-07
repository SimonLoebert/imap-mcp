import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as openpgp from "openpgp";
import { db } from "@/lib/db";
import { mailAccounts, pgpKeys, type PgpKeySource } from "@/lib/db/schema";
import { keyEmails } from "@/lib/pgp";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** What the UI and MCP clients get to see of a keyring entry. */
export interface KeyringEntry {
  id: string;
  email: string;
  fingerprint: string;
  source: PgpKeySource;
  userIds: string[];
  canEncrypt: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = typeof pgpKeys.$inferSelect;

async function describe(row: Row): Promise<KeyringEntry> {
  let userIds: string[] = [];
  let canEncrypt = false;
  let expiresAt: string | null = null;
  try {
    const key = await openpgp.readKey({ armoredKey: row.publicKey });
    userIds = key.getUserIDs();
    canEncrypt = await usableForEncryption(key);
    const expiry = await key.getExpirationTime();
    expiresAt = expiry instanceof Date ? expiry.toISOString() : null;
  } catch {
    // An unreadable row is still listed so the owner can delete it.
  }
  return {
    id: row.id,
    email: row.email,
    fingerprint: row.fingerprint,
    source: row.source,
    userIds,
    canEncrypt,
    expiresAt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function usableForEncryption(key: openpgp.Key): Promise<boolean> {
  try {
    await key.getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one or more public keys from armored text or binary data. A private
 * key is reduced to its public part, so a pasted secret key never gets stored.
 */
export async function parsePublicKeys(input: string | Uint8Array): Promise<openpgp.PublicKey[]> {
  let keys: openpgp.Key[];
  try {
    keys =
      typeof input === "string"
        ? await openpgp.readKeys({ armoredKeys: input.trim() })
        : await openpgp.readKeys({ binaryKeys: input });
  } catch {
    throw new Error("Not an OpenPGP public key (-----BEGIN PGP PUBLIC KEY BLOCK-----)");
  }
  return keys.map((k) => (k.isPrivate() ? k.toPublic() : (k as openpgp.PublicKey)));
}

export type ImportStatus = "added" | "updated" | "unchanged" | "conflict" | "replaced";

export interface ImportResult {
  email: string;
  fingerprint: string;
  status: ImportStatus;
  /** Fingerprint already on file when status is "conflict" or "replaced". */
  existingFingerprint?: string;
}

/**
 * Store a key under every address in its user IDs (optionally only `onlyEmail`).
 * The same fingerprint refreshes the stored copy (new subkeys, extended
 * expiry). A *different* key for an address that already has one is a
 * conflict unless `replace` is set — only the owner in the web UI does that,
 * so neither learning from mail nor an MCP client can swap a key silently.
 */
export async function importKey(
  userId: string,
  key: openpgp.PublicKey,
  source: PgpKeySource,
  opts: { replace?: boolean; onlyEmail?: string } = {},
): Promise<ImportResult[]> {
  if (key.isRevoked && (await key.isRevoked())) throw new Error("This key is revoked");
  const fingerprint = key.getFingerprint().toUpperCase();
  let emails = keyEmails(key);
  if (opts.onlyEmail) emails = emails.filter((e) => e === normalizeEmail(opts.onlyEmail!));
  if (!emails.length) {
    throw new Error(
      opts.onlyEmail
        ? `The key has no user ID for ${opts.onlyEmail}`
        : "The key has no user ID with an e-mail address",
    );
  }
  const armored = key.armor();
  const results: ImportResult[] = [];
  for (const email of emails) {
    const [existing] = await db
      .select()
      .from(pgpKeys)
      .where(and(eq(pgpKeys.userId, userId), eq(pgpKeys.email, email)))
      .limit(1);
    if (!existing) {
      const inserted = await db
        .insert(pgpKeys)
        .values({ userId, email, fingerprint, publicKey: armored, source })
        .onConflictDoNothing()
        .returning({ id: pgpKeys.id });
      results.push({ email, fingerprint, status: inserted.length ? "added" : "conflict" });
      continue;
    }
    if (existing.fingerprint === fingerprint) {
      if (existing.publicKey === armored) {
        results.push({ email, fingerprint, status: "unchanged" });
      } else {
        await db
          .update(pgpKeys)
          .set({ publicKey: armored, updatedAt: new Date() })
          .where(and(eq(pgpKeys.id, existing.id), eq(pgpKeys.userId, userId)));
        results.push({ email, fingerprint, status: "updated" });
      }
      continue;
    }
    if (!opts.replace) {
      results.push({
        email,
        fingerprint,
        status: "conflict",
        existingFingerprint: existing.fingerprint,
      });
      continue;
    }
    await db
      .update(pgpKeys)
      .set({ fingerprint, publicKey: armored, source, updatedAt: new Date() })
      .where(and(eq(pgpKeys.id, existing.id), eq(pgpKeys.userId, userId)));
    results.push({
      email,
      fingerprint,
      status: "replaced",
      existingFingerprint: existing.fingerprint,
    });
  }
  return results;
}

export async function listKeyring(
  userId: string,
  opts: { email?: string } = {},
): Promise<KeyringEntry[]> {
  const conditions = [eq(pgpKeys.userId, userId)];
  if (opts.email) {
    conditions.push(sql`${pgpKeys.email} like ${`%${opts.email.trim().toLowerCase()}%`}`);
  }
  const rows = await db
    .select()
    .from(pgpKeys)
    .where(and(...conditions))
    .orderBy(pgpKeys.email);
  return Promise.all(rows.map(describe));
}

export async function getKeyringEntry(userId: string, id: string): Promise<KeyringEntry | null> {
  const [row] = await db
    .select()
    .from(pgpKeys)
    .where(and(eq(pgpKeys.id, id), eq(pgpKeys.userId, userId)))
    .limit(1);
  return row ? describe(row) : null;
}

export async function deleteKeyringEntry(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(pgpKeys)
    .where(and(eq(pgpKeys.id, id), eq(pgpKeys.userId, userId)))
    .returning({ id: pgpKeys.id });
  return rows.length > 0;
}

export interface ResolvedKey {
  email: string;
  key: openpgp.PublicKey;
  fingerprint: string;
  /** "account" when the address is one of the user's own mail accounts. */
  source: PgpKeySource | "account";
}

/**
 * Public keys for the given addresses: the user's own accounts first, then the
 * keyring, then — when `wkd` is set — a Web Key Directory lookup whose result
 * is stored in the keyring. Keys that cannot encrypt (expired, revoked, no
 * encryption subkey) count as missing.
 */
export async function resolveRecipientKeys(
  userId: string,
  addresses: string[],
  opts: { wkd?: boolean } = {},
): Promise<{ keys: Map<string, ResolvedKey>; missing: string[] }> {
  const wanted = [...new Set(addresses.map(normalizeEmail))].filter(Boolean);
  const keys = new Map<string, ResolvedKey>();
  if (!wanted.length) return { keys, missing: [] };

  const candidates: Array<{ email: string; armored: string; source: ResolvedKey["source"] }> = [];
  const own = await db
    .select({ email: mailAccounts.email, publicKey: mailAccounts.pgpPublicKey })
    .from(mailAccounts)
    .where(
      and(eq(mailAccounts.userId, userId), inArray(sql`lower(${mailAccounts.email})`, wanted)),
    );
  for (const o of own) {
    if (o.publicKey) {
      candidates.push({ email: normalizeEmail(o.email), armored: o.publicKey, source: "account" });
    }
  }
  const ring = await db
    .select()
    .from(pgpKeys)
    .where(and(eq(pgpKeys.userId, userId), inArray(pgpKeys.email, wanted)));
  for (const r of ring) candidates.push({ email: r.email, armored: r.publicKey, source: r.source });

  for (const c of candidates) {
    if (keys.has(c.email)) continue;
    try {
      const key = await openpgp.readKey({ armoredKey: c.armored });
      if (await usableForEncryption(key)) {
        keys.set(c.email, {
          email: c.email,
          key: key as openpgp.PublicKey,
          fingerprint: key.getFingerprint().toUpperCase(),
          source: c.source,
        });
      }
    } catch {
      // unreadable — treat as missing
    }
  }

  if (opts.wkd) {
    for (const email of wanted) {
      if (keys.has(email) || ring.some((r) => r.email === email)) continue;
      const found = await wkdLookup(email).catch(() => null);
      if (!found || !(await usableForEncryption(found))) continue;
      await importKey(userId, found, "wkd", { onlyEmail: email });
      keys.set(email, {
        email,
        key: found,
        fingerprint: found.getFingerprint().toUpperCase(),
        source: "wkd",
      });
    }
  }

  return { keys, missing: wanted.filter((e) => !keys.has(e)) };
}

/** The key to verify a signature from `email` against, if we have one. */
export async function senderKey(
  userId: string,
  email: string,
): Promise<{ key: openpgp.PublicKey; source: ResolvedKey["source"] } | null> {
  const addr = normalizeEmail(email);
  const [own] = await db
    .select({ publicKey: mailAccounts.pgpPublicKey })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.userId, userId), eq(sql`lower(${mailAccounts.email})`, addr)))
    .limit(1);
  const [ring] = own?.publicKey
    ? []
    : await db
        .select()
        .from(pgpKeys)
        .where(and(eq(pgpKeys.userId, userId), eq(pgpKeys.email, addr)))
        .limit(1);
  const armored = own?.publicKey ?? ring?.publicKey;
  if (!armored) return null;
  try {
    const key = (await openpgp.readKey({ armoredKey: armored })) as openpgp.PublicKey;
    return { key, source: own?.publicKey ? "account" : ring!.source };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Web Key Directory (draft-koch-openpgp-webkey-service)

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

export function zbase32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
  return out;
}

export function wkdUrls(email: string): string[] {
  const at = email.lastIndexOf("@");
  if (at < 1) return [];
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain || isIP(domain) || !/^[a-z0-9.-]+$/.test(domain)) return [];
  const hash = zbase32(createHash("sha1").update(local.toLowerCase()).digest());
  const l = encodeURIComponent(local);
  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${l}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${l}`,
  ];
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".corp"];

/**
 * Only public DNS names are fetched: the address comes from a recipient list
 * an MCP client wrote, so it must not become a way to probe internal hosts.
 */
async function isPublicHost(host: string): Promise<boolean> {
  const h = host.toLowerCase();
  if (isIP(h) || !h.includes(".") || h === "localhost") return false;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return false;
  try {
    const addrs = await lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

const WKD_MAX_BYTES = 256 * 1024;

/** Fetch the key for `email` from its domain's Web Key Directory, or null. */
export async function wkdLookup(email: string): Promise<openpgp.PublicKey | null> {
  const addr = normalizeEmail(email);
  for (const url of wkdUrls(email.trim())) {
    try {
      if (!(await isPublicHost(new URL(url).hostname))) continue;
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > WKD_MAX_BYTES) continue;
      const keys = await parsePublicKeys(new Uint8Array(buf));
      // The directory may serve several keys; only one with a matching user ID counts.
      const match = keys.find((k) => keyEmails(k).includes(addr));
      if (match) return match;
    } catch {
      // try the next URL
    }
  }
  return null;
}
