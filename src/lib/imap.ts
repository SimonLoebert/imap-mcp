import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type ListResponse,
} from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { decrypt } from "@/lib/crypto";
import type { MailAccount } from "@/lib/db/schema";

export type AccountLike = Pick<
  MailAccount,
  "imapHost" | "imapPort" | "imapSecure" | "imapUser" | "imapPasswordEnc"
>;

function buildClient(acc: AccountLike): ImapFlow {
  return new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: {
      user: acc.imapUser,
      pass: decrypt(acc.imapPasswordEnc),
    },
    logger: false,
  });
}

export async function withImap<T>(
  acc: AccountLike,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = buildClient(acc);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

export async function testImapConnection(acc: AccountLike): Promise<void> {
  await withImap(acc, async (client) => {
    await client.noop();
  });
}

export async function listFolders(acc: AccountLike): Promise<
  Array<{ path: string; name: string; specialUse?: string | null; subscribed?: boolean }>
> {
  return withImap(acc, async (client) => {
    const raw: ListResponse[] = await client.list();
    return raw.map((f) => ({
      path: f.path,
      name: f.name,
      specialUse: f.specialUse ?? null,
      subscribed: f.subscribed,
    }));
  });
}

export interface MessageSummary {
  uid: number;
  seq: number;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  /** When the server received the message — what status tracking compares against. */
  internalDate: string | null;
  flags: string[];
  messageId: string | null;
  /** Bare address of the first From entry, lower-cased. */
  fromAddress: string | null;
  /** In-Reply-To plus References: the Message-IDs this message answers. */
  references: string[];
  preview?: string | null;
}

/** Everything toSummary() reads. */
const SUMMARY_FETCH: FetchQueryObject = {
  envelope: true,
  flags: true,
  uid: true,
  internalDate: true,
  headers: ["references"],
};

/** Extract every `<id>` token from a raw References header block. */
function parseReferencesHeader(raw: Buffer | undefined): string[] {
  if (!raw) return [];
  return raw.toString("utf8").match(/<[^<>\s]+>/g) ?? [];
}

export interface ListMessagesOptions {
  folder: string;
  limit?: number;
  since?: Date;
  unreadOnly?: boolean;
}

export async function listMessages(
  acc: AccountLike,
  opts: ListMessagesOptions,
): Promise<MessageSummary[]> {
  const { folder, limit = 50, since, unreadOnly } = opts;
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const search: Record<string, unknown> = {};
      if (since) search.since = since;
      if (unreadOnly) search.seen = false;
      const uids = await client.search(search, { uid: true });
      if (!uids || uids.length === 0) return [];
      const tail = uids.slice(-limit).reverse();
      const results: MessageSummary[] = [];
      for await (const msg of client.fetch({ uid: tail.join(",") }, SUMMARY_FETCH, {
        uid: true,
      })) {
        results.push(toSummary(msg));
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

function toSummary(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  const from = env?.from?.[0];
  const to = env?.to?.[0];
  const references = parseReferencesHeader(msg.headers);
  if (env?.inReplyTo && !references.includes(env.inReplyTo)) references.push(env.inReplyTo);
  return {
    uid: msg.uid,
    seq: msg.seq,
    subject: env?.subject ?? null,
    from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : null,
    to: to ? `${to.name ?? ""} <${to.address ?? ""}>`.trim() : null,
    date: env?.date ? new Date(env.date).toISOString() : null,
    internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
    flags: msg.flags ? Array.from(msg.flags) : [],
    messageId: env?.messageId ?? null,
    fromAddress: from?.address ? from.address.toLowerCase() : null,
    references,
  };
}

/** Summaries for specific UIDs of one folder; UIDs that don't exist are simply absent. */
export async function fetchSummaries(
  acc: AccountLike,
  folder: string,
  uids: number[],
): Promise<MessageSummary[]> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const results: MessageSummary[] = [];
      for await (const msg of client.fetch({ uid: uidRange(uids) }, SUMMARY_FETCH, {
        uid: true,
      })) {
        results.push(toSummary(msg));
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

/**
 * Folders a scan for incoming mail skips by default: outgoing, drafts,
 * rubbish, and Gmail's "All Mail", which only duplicates the other folders.
 */
const NON_INBOUND_SPECIAL_USE = new Set(["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\All"]);

export interface ScanOptions {
  /** Restrict the scan to these folder paths; default: every inbound folder. */
  folders?: string[];
}

/**
 * Every message received at or after `since`, across folders. One IMAP
 * session; a folder that cannot be selected is skipped and reported.
 */
export async function scanMessagesSince(
  acc: AccountLike,
  since: Date,
  opts: ScanOptions = {},
): Promise<{ messages: Array<MessageSummary & { folder: string }>; failedFolders: string[] }> {
  return withImap(acc, async (client) => {
    const all = await client.list();
    const wanted = opts.folders ? new Set(opts.folders) : null;
    const folders = all.filter((f) => {
      if (f.flags?.has("\\Noselect") || f.flags?.has("\\NonExistent")) return false;
      if (wanted) return wanted.has(f.path);
      return !f.specialUse || !NON_INBOUND_SPECIAL_USE.has(f.specialUse);
    });

    const messages: Array<MessageSummary & { folder: string }> = [];
    const failedFolders: string[] = [];
    for (const f of folders) {
      let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        lock = await client.getMailboxLock(f.path);
        // SEARCH SINCE has day granularity — filter to the exact instant below.
        const uids = await client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) continue;
        for await (const msg of client.fetch({ uid: uids.join(",") }, SUMMARY_FETCH, {
          uid: true,
        })) {
          const summary = toSummary(msg);
          if (summary.internalDate && new Date(summary.internalDate) < since) continue;
          messages.push({ ...summary, folder: f.path });
        }
      } catch {
        failedFolders.push(f.path);
      } finally {
        lock?.release();
      }
    }
    return { messages, failedFolders };
  });
}

export interface FullMessage {
  uid: number;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  internalDate: string | null;
  text: string | null;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: Array<{
    index: number;
    filename: string | null;
    size: number;
    contentType: string;
    contentId: string | null;
    isInline: boolean;
  }>;
}

export async function getMessage(
  acc: AccountLike,
  folder: string,
  uid: number,
): Promise<FullMessage | null> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { source: true, envelope: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;
      const parsed: ParsedMail = await simpleParser(msg.source);
      return {
        uid: msg.uid,
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        date: parsed.date ? parsed.date.toISOString() : null,
        internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        text: parsed.text ?? null,
        html: typeof parsed.html === "string" ? parsed.html : null,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        attachments: (parsed.attachments ?? []).map((a, index) => ({
          index,
          filename: a.filename ?? null,
          size: a.size ?? 0,
          contentType: a.contentType ?? "application/octet-stream",
          contentId: a.contentId ?? null,
          isInline: a.contentDisposition === "inline",
        })),
      };
    } finally {
      lock.release();
    }
  });
}

function addrList(
  field: ParsedMail["to"] | ParsedMail["cc"] | ParsedMail["from"],
): string[] {
  if (!field) return [];
  const arr = Array.isArray(field) ? field : [field];
  return arr.map((a) => a.text).filter(Boolean);
}

export interface AttachmentContent {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
  base64: string;
}

export interface ThreadOptions {
  maxMessages?: number;
  crossFolder?: boolean;
}

export type ThreadMessage = FullMessage & { folder: string };

export interface ThreadFetchResult {
  strategy: "gmail-thrid" | "references";
  threadId?: string | null;
  messages: ThreadMessage[];
  truncated: boolean;
}

export async function getThread(
  acc: AccountLike,
  folder: string,
  uid: number,
  opts: ThreadOptions = {},
): Promise<ThreadFetchResult | null> {
  const max = Math.max(1, Math.min(opts.maxMessages ?? 50, 200));

  return withImap(acc, async (client) => {
    const folders = opts.crossFolder
      ? (await client.list()).map((f) => f.path)
      : [folder];

    // 1) Anchor the thread from the target message: envelope + Gmail thread id
    //    if the server supports X-GM-EXT, + parsed References from the source.
    let anchorEnv: FetchMessageObject | null = null;
    let anchorReferences: string[] = [];
    let threadId: string | null = null;
    {
      const lock = await client.getMailboxLock(folder);
      try {
        const fetched = await client.fetchOne(
          String(uid),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { envelope: true, threadId: true, source: true } as any,
          { uid: true },
        );
        anchorEnv = fetched || null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        threadId = (anchorEnv as any)?.threadId ?? null;
        if (anchorEnv?.source) {
          const parsed = await simpleParser(anchorEnv.source);
          anchorReferences = Array.isArray(parsed.references)
            ? parsed.references
            : parsed.references
              ? [parsed.references]
              : [];
        }
      } finally {
        lock.release();
      }
    }
    if (!anchorEnv) return null;

    // Deduplicate messages across folders by Message-ID (preferred) or (folder,uid).
    type Entry = { folder: string; uid: number };
    const collected = new Map<string, Entry>();
    const keyFor = (f: string, u: number) => `${f}#${u}`;
    collected.set(keyFor(folder, uid), { folder, uid });

    async function searchIn(f: string, query: Record<string, unknown>) {
      const lock = await client.getMailboxLock(f);
      try {
        const uids = (await client.search(query, { uid: true })) as
          | number[]
          | false;
        if (Array.isArray(uids)) {
          for (const u of uids) collected.set(keyFor(f, u), { folder: f, uid: u });
        }
      } catch {
        /* folder not accessible / search unsupported — skip silently */
      } finally {
        lock.release();
      }
    }

    // 2a) Gmail fast-path: let the server group by X-GM-THRID.
    if (threadId) {
      for (const f of folders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await searchIn(f, { threadId } as any);
      }
    }

    // 2b) References-chain fallback — also runs alongside Gmail to catch edge
    //     cases where a message in the thread sits in a non-indexed label.
    const seedIds = new Set<string>();
    if (anchorEnv.envelope?.messageId) seedIds.add(anchorEnv.envelope.messageId);
    if (anchorEnv.envelope?.inReplyTo) seedIds.add(anchorEnv.envelope.inReplyTo);
    for (const r of anchorReferences) seedIds.add(r);

    for (const id of seedIds) {
      for (const f of folders) {
        await searchIn(f, { header: ["message-id", id] });
        await searchIn(f, { header: ["references", id] });
      }
    }

    // 3) Hydrate each entry via the same IMAP connection (no per-message
    //    reconnect). We fetch source once and parse locally.
    const entries = Array.from(collected.values());
    const truncated = entries.length > max;
    const sliced = entries.slice(0, max);
    const messages: ThreadMessage[] = [];
    for (const e of sliced) {
      const lock = await client.getMailboxLock(e.folder);
      try {
        const fetched = await client.fetchOne(
          String(e.uid),
          { envelope: true, source: true, internalDate: true },
          { uid: true },
        );
        const msg = fetched || null;
        if (!msg?.source) continue;
        const parsed: ParsedMail = await simpleParser(msg.source);
        messages.push({
          folder: e.folder,
          uid: msg.uid,
          subject: parsed.subject ?? null,
          from: parsed.from?.text ?? null,
          to: addrList(parsed.to),
          cc: addrList(parsed.cc),
          date: parsed.date ? parsed.date.toISOString() : null,
          internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
          text: parsed.text ?? null,
          html: typeof parsed.html === "string" ? parsed.html : null,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references: Array.isArray(parsed.references)
            ? parsed.references
            : parsed.references
              ? [parsed.references]
              : [],
          attachments: (parsed.attachments ?? []).map((a, index) => ({
            index,
            filename: a.filename ?? null,
            size: a.size ?? 0,
            contentType: a.contentType ?? "application/octet-stream",
            contentId: a.contentId ?? null,
            isInline: a.contentDisposition === "inline",
          })),
        });
      } finally {
        lock.release();
      }
    }

    // Deduplicate by Message-ID (same message cross-referenced in multiple
    // folders, e.g. INBOX + [Gmail]/All Mail) — keep the first occurrence.
    const seenIds = new Set<string>();
    const deduped: ThreadMessage[] = [];
    for (const m of messages) {
      if (m.messageId && seenIds.has(m.messageId)) continue;
      if (m.messageId) seenIds.add(m.messageId);
      deduped.push(m);
    }

    deduped.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });

    return {
      strategy: threadId ? "gmail-thrid" : "references",
      threadId,
      messages: deduped,
      truncated,
    };
  });
}

export async function getAttachment(
  acc: AccountLike,
  folder: string,
  uid: number,
  index: number,
): Promise<AttachmentContent | null> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed: ParsedMail = await simpleParser(msg.source);
      const att = parsed.attachments?.[index];
      if (!att) return null;
      const buf = Buffer.isBuffer(att.content)
        ? att.content
        : Buffer.from(att.content as Uint8Array);
      return {
        index,
        filename: att.filename ?? null,
        contentType: att.contentType ?? "application/octet-stream",
        size: att.size ?? buf.length,
        contentId: att.contentId ?? null,
        isInline: att.contentDisposition === "inline",
        base64: buf.toString("base64"),
      };
    } finally {
      lock.release();
    }
  });
}

export interface SearchCriteria {
  folder: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  dateFrom?: Date;
  dateTo?: Date;
  unreadOnly?: boolean;
  /** Exact Message-ID header, e.g. "<abc@example.com>". */
  messageId?: string;
  limit?: number;
}

export async function searchMessages(
  acc: AccountLike,
  crit: SearchCriteria,
): Promise<MessageSummary[]> {
  const { folder, limit = 50 } = crit;
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const query: Record<string, unknown> = {};
      if (crit.from) query.from = crit.from;
      if (crit.to) query.to = crit.to;
      if (crit.subject) query.subject = crit.subject;
      if (crit.body) query.body = crit.body;
      if (crit.dateFrom) query.since = crit.dateFrom;
      if (crit.dateTo) query.before = crit.dateTo;
      if (crit.unreadOnly) query.seen = false;
      if (crit.messageId) query.header = { "message-id": crit.messageId };
      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) return [];
      const tail = uids.slice(-limit).reverse();
      const results: MessageSummary[] = [];
      for await (const msg of client.fetch({ uid: tail.join(",") }, SUMMARY_FETCH, {
        uid: true,
      })) {
        results.push(toSummary(msg));
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

function uidRange(uids: number[]): string {
  if (!uids.length) throw new Error("uids is empty");
  return uids.join(",");
}

export interface FlagMutationResult {
  uids: number[];
  added: string[];
  removed: string[];
}

export async function setMessageFlags(
  acc: AccountLike,
  folder: string,
  uids: number[],
  opts: { add?: string[]; remove?: string[] },
): Promise<FlagMutationResult> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = uidRange(uids);
      if (opts.add?.length) {
        await client.messageFlagsAdd(range, opts.add, { uid: true });
      }
      if (opts.remove?.length) {
        await client.messageFlagsRemove(range, opts.remove, { uid: true });
      }
      return { uids, added: opts.add ?? [], removed: opts.remove ?? [] };
    } finally {
      lock.release();
    }
  });
}

export interface MoveResult {
  moved: number;
  sourceUids: number[];
  destination: string;
}

export async function moveMessages(
  acc: AccountLike,
  fromFolder: string,
  uids: number[],
  toFolder: string,
): Promise<MoveResult> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(fromFolder);
    try {
      const range = uidRange(uids);
      await client.messageMove(range, toFolder, { uid: true });
      return { moved: uids.length, sourceUids: uids, destination: toFolder };
    } finally {
      lock.release();
    }
  });
}

export async function copyMessages(
  acc: AccountLike,
  fromFolder: string,
  uids: number[],
  toFolder: string,
): Promise<MoveResult> {
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock(fromFolder);
    try {
      const range = uidRange(uids);
      await client.messageCopy(range, toFolder, { uid: true });
      return { moved: uids.length, sourceUids: uids, destination: toFolder };
    } finally {
      lock.release();
    }
  });
}

async function findSentFolder(client: ImapFlow): Promise<string | null> {
  const all = await client.list();
  const byUse = all.find((f) => f.specialUse === "\\Sent");
  if (byUse) return byUse.path;
  const byName = all.find((f) =>
    /^(sent|sent items|sent mail|envoy[eé]s?|éléments envoyés|gesendet|posta inviata|inviati|enviad[oa]s?)$/i.test(
      f.name,
    ),
  );
  return byName?.path ?? null;
}

export interface SaveSentResult {
  ok: boolean;
  folder?: string | null;
  skipped?: boolean;
  error?: string;
}

export async function saveToSentFolder(
  acc: AccountLike,
  rawMime: Buffer,
): Promise<SaveSentResult> {
  try {
    return await withImap(acc, async (client) => {
      const sent = await findSentFolder(client);
      if (!sent) return { ok: false, folder: null, error: "no Sent folder detected" };
      await client.append(sent, rawMime, ["\\Seen"]);
      return { ok: true, folder: sent };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function findTrashFolder(client: ImapFlow): Promise<string | null> {
  const all = await client.list();
  const byUse = all.find((f) => f.specialUse === "\\Trash");
  if (byUse) return byUse.path;
  const byName = all.find((f) =>
    /^(trash|corbeille|deleted items|deleted|papierkorb)$/i.test(f.name),
  );
  return byName?.path ?? null;
}

export interface DeleteResult {
  deleted: number;
  moved_to_trash: boolean;
  trash_folder?: string | null;
}

export async function deleteMessages(
  acc: AccountLike,
  folder: string,
  uids: number[],
  opts: { permanent?: boolean } = {},
): Promise<DeleteResult> {
  return withImap(acc, async (client) => {
    const range = uidRange(uids);
    if (!opts.permanent) {
      const trash = await findTrashFolder(client);
      if (trash && trash !== folder) {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageMove(range, trash, { uid: true });
        } finally {
          lock.release();
        }
        return { deleted: uids.length, moved_to_trash: true, trash_folder: trash };
      }
    }
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(range, { uid: true });
      return { deleted: uids.length, moved_to_trash: false, trash_folder: null };
    } finally {
      lock.release();
    }
  });
}

export async function createFolder(acc: AccountLike, path: string): Promise<{ path: string }> {
  return withImap(acc, async (client) => {
    await client.mailboxCreate(path);
    return { path };
  });
}

export async function renameFolder(
  acc: AccountLike,
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  return withImap(acc, async (client) => {
    await client.mailboxRename(from, to);
    return { from, to };
  });
}

export async function deleteFolder(acc: AccountLike, path: string): Promise<{ path: string }> {
  return withImap(acc, async (client) => {
    await client.mailboxDelete(path);
    return { path };
  });
}
