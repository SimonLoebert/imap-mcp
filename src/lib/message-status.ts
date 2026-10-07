import { and, count, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageStatuses, type MailAccount, type MessageStatusRow } from "@/lib/db/schema";
import { fetchSummaries, scanMessagesSince, type MessageSummary } from "@/lib/imap";
import type {
  ActionableResult,
  ActionableTracked,
  MessageStatus,
  MessageStatusSource,
  NewMessageView,
  ThreadHold,
  TrackedMessageView,
} from "@/lib/message-status-types";

/**
 * Processing status of received messages ("new" → "unhandled" → "handled",
 * or parked on "hold" until a date). Shared by the MCP tools and the status
 * dashboard.
 *
 * Only explicit decisions are stored. A message without a row is `new`,
 * unless it arrived before the account's `statusTrackingSince` or was sent by
 * the account itself — those count as `handled`.
 */

export const NOTE_MAX = 1000;

export class MessageStatusInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageStatusInputError";
  }
}

export interface StatusInput {
  status: MessageStatus;
  /** YYYY-MM-DD; required for `hold`, refused otherwise. */
  holdUntil?: string | null;
  /** undefined keeps the stored note, null clears it. */
  note?: string | null;
}

export interface StatusAnnotation {
  status: MessageStatus;
  statusSource: MessageStatusSource;
  holdUntil: string | null;
  holdDue: boolean;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  /** A held message this one answers — e.g. the reply you were waiting for. */
  threadHold: ThreadHold | null;
}

/** What annotate() needs to know about a message. */
export interface StatusTarget {
  folder: string;
  uid: number;
  messageId: string | null;
  fromAddress: string | null;
  /** Arrival time (IMAP internal date), falling back to the Date header. */
  receivedAt: string | null;
  references: string[];
}

type Account = Pick<MailAccount, "id" | "userId" | "email" | "statusTrackingSince">;

/** The calendar date `hold_until` is compared against, in APP_TIMEZONE (default UTC). */
export function today(): string {
  const tz = process.env.APP_TIMEZONE || "UTC";
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function isHoldDue(holdUntil: string | null, now = today()): boolean {
  return holdUntil !== null && holdUntil <= now;
}

function normalizeMessageId(id: string): string {
  const t = id.trim();
  return t.startsWith("<") ? t : `<${t}>`;
}

/** Stable key for a message: its Message-ID, or folder + UID when it has none. */
export function messageKey(m: { messageId: string | null; folder: string; uid: number }): string {
  return m.messageId?.trim() ? normalizeMessageId(m.messageId) : `uid:${m.folder}:${m.uid}`;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Reject inconsistent input before anything touches the database. */
export function validateStatusInput(input: StatusInput): StatusInput {
  const holdUntil = input.holdUntil?.trim() || null;
  if (input.status === "hold") {
    if (!holdUntil) {
      throw new MessageStatusInputError("status \"hold\" requires hold_until (YYYY-MM-DD)");
    }
    if (!isValidDate(holdUntil)) {
      throw new MessageStatusInputError(`hold_until must be a date as YYYY-MM-DD, got "${holdUntil}"`);
    }
    if (holdUntil < today()) {
      throw new MessageStatusInputError(`hold_until ${holdUntil} lies in the past (today is ${today()})`);
    }
  } else if (holdUntil) {
    throw new MessageStatusInputError(`hold_until is only allowed with status "hold"`);
  }
  let note = input.note;
  if (typeof note === "string") {
    note = note.trim() || null;
    if (note && note.length > NOTE_MAX) {
      throw new MessageStatusInputError(`note is longer than ${NOTE_MAX} characters`);
    }
  }
  return { status: input.status, holdUntil, note };
}

function toThreadHold(row: MessageStatusRow, now: string): ThreadHold {
  return {
    messageId: row.messageKey,
    folder: row.folder,
    uid: row.uid,
    subject: row.subject,
    holdUntil: row.holdUntil!,
    holdDue: isHoldDue(row.holdUntil, now),
    note: row.note,
  };
}

/** The earliest-due hold among the messages `refs` points at. */
function findThreadHold(
  refs: string[],
  ownKey: string,
  rowsByKey: Map<string, MessageStatusRow>,
  now: string,
): ThreadHold | null {
  let best: MessageStatusRow | null = null;
  for (const ref of refs) {
    const key = normalizeMessageId(ref);
    if (key === ownKey) continue;
    const row = rowsByKey.get(key);
    if (row?.status !== "hold" || !row.holdUntil) continue;
    if (!best || row.holdUntil < best.holdUntil!) best = row;
  }
  return best ? toThreadHold(best, now) : null;
}

function implicitStatus(
  account: Account,
  t: Pick<StatusTarget, "fromAddress" | "receivedAt">,
): { status: MessageStatus; source: MessageStatusSource } {
  if (t.receivedAt && new Date(t.receivedAt) < account.statusTrackingSince) {
    return { status: "handled", source: "implicit_before_tracking" };
  }
  if (t.fromAddress && t.fromAddress.toLowerCase() === account.email.trim().toLowerCase()) {
    return { status: "handled", source: "implicit_own_message" };
  }
  return { status: "new", source: "implicit_new" };
}

async function rowsForKeys(account: Account, keys: string[]): Promise<MessageStatusRow[]> {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(messageStatuses)
    .where(
      and(
        eq(messageStatuses.userId, account.userId),
        eq(messageStatuses.accountId, account.id),
        inArray(messageStatuses.messageKey, keys),
      ),
    );
}

/** Effective status of each target, in input order. One query for the whole batch. */
export async function annotate(
  account: Account,
  targets: StatusTarget[],
): Promise<StatusAnnotation[]> {
  const keys = new Set<string>();
  for (const t of targets) {
    keys.add(messageKey(t));
    for (const r of t.references) keys.add(normalizeMessageId(r));
  }
  const rows = await rowsForKeys(account, Array.from(keys));
  const rowsByKey = new Map(rows.map((r) => [r.messageKey, r]));
  const now = today();

  return targets.map((t) => {
    const key = messageKey(t);
    const row = rowsByKey.get(key);
    const threadHold = findThreadHold(t.references, key, rowsByKey, now);
    if (row) {
      return {
        status: row.status,
        statusSource: "stored",
        holdUntil: row.holdUntil,
        holdDue: isHoldDue(row.holdUntil, now),
        statusNote: row.note,
        statusUpdatedAt: row.updatedAt.toISOString(),
        threadHold,
      };
    }
    const implicit = implicitStatus(account, t);
    return {
      status: implicit.status,
      statusSource: implicit.source,
      holdUntil: null,
      holdDue: false,
      statusNote: null,
      statusUpdatedAt: null,
      threadHold,
    };
  });
}

export function summaryTarget(m: MessageSummary, folder: string): StatusTarget {
  return {
    folder,
    uid: m.uid,
    messageId: m.messageId,
    fromAddress: m.fromAddress,
    receivedAt: m.internalDate ?? m.date,
    references: m.references,
  };
}

/** Pull a bare address out of "Name <addr>" (or return the input). */
export function bareAddress(from: string | null): string | null {
  if (!from) return null;
  const m = from.match(/<([^<>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase() || null;
}

export interface SetStatusResult {
  updated: Array<{
    uid: number;
    messageId: string;
    status: MessageStatus;
    holdUntil: string | null;
    note: string | null;
  }>;
  notFound: number[];
}

/**
 * Store a status for messages addressed by folder + UID. The UIDs are
 * resolved to Message-IDs over IMAP first, so the status follows the message
 * if it is moved later.
 */
export async function setStatusForUids(
  account: MailAccount,
  folder: string,
  uids: number[],
  rawInput: StatusInput,
  clientId: string | null,
): Promise<SetStatusResult> {
  const input = validateStatusInput(rawInput);
  const summaries = await fetchSummaries(account, folder, uids);
  const found = new Set(summaries.map((s) => s.uid));
  const updated: SetStatusResult["updated"] = [];

  for (const s of summaries) {
    const key = messageKey({ messageId: s.messageId, folder, uid: s.uid });
    const snapshot = {
      folder,
      uid: s.uid,
      subject: s.subject,
      fromAddress: s.from,
      messageDate: s.internalDate ? new Date(s.internalDate) : s.date ? new Date(s.date) : null,
      updatedByClientId: clientId,
    };
    const [row] = await db
      .insert(messageStatuses)
      .values({
        userId: account.userId,
        accountId: account.id,
        messageKey: key,
        status: input.status,
        holdUntil: input.holdUntil ?? null,
        note: input.note ?? null,
        ...snapshot,
      })
      .onConflictDoUpdate({
        target: [messageStatuses.accountId, messageStatuses.messageKey],
        set: {
          status: input.status,
          holdUntil: input.holdUntil ?? null,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...snapshot,
          updatedAt: sql`now()`,
        },
        // The unique index is per account and the account was loaded for this
        // user, but keep the tenant check in the statement itself.
        setWhere: eq(messageStatuses.userId, account.userId),
      })
      .returning();
    if (row) {
      updated.push({
        uid: row.uid,
        messageId: row.messageKey,
        status: row.status,
        holdUntil: row.holdUntil,
        note: row.note,
      });
    }
  }

  return { updated, notFound: uids.filter((u) => !found.has(u)) };
}

function toView(row: MessageStatusRow, now: string): TrackedMessageView {
  return {
    id: row.id,
    accountId: row.accountId,
    messageId: row.messageKey,
    status: row.status,
    holdUntil: row.holdUntil,
    holdDue: isHoldDue(row.holdUntil, now),
    note: row.note,
    folder: row.folder,
    uid: row.uid,
    subject: row.subject,
    fromAddress: row.fromAddress,
    messageDate: row.messageDate?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Change a stored status from the dashboard. Returns null when the row is not the user's. */
export async function updateStatusById(
  userId: string,
  id: string,
  rawInput: StatusInput,
): Promise<TrackedMessageView | null> {
  const input = validateStatusInput(rawInput);
  const [row] = await db
    .update(messageStatuses)
    .set({
      status: input.status,
      holdUntil: input.holdUntil ?? null,
      ...(input.note !== undefined ? { note: input.note } : {}),
      updatedByClientId: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(messageStatuses.id, id), eq(messageStatuses.userId, userId)))
    .returning();
  return row ? toView(row, today()) : null;
}

/** Forget a stored status; the message falls back to its implicit status. */
export async function deleteStatus(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(messageStatuses)
    .where(and(eq(messageStatuses.id, id), eq(messageStatuses.userId, userId)))
    .returning({ id: messageStatuses.id });
  return rows.length > 0;
}

/** Stored messages that need the user now: unhandled ones and due holds. For the nav badge. */
export async function countAttention(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messageStatuses)
    .where(
      and(
        eq(messageStatuses.userId, userId),
        or(
          eq(messageStatuses.status, "unhandled"),
          and(eq(messageStatuses.status, "hold"), lte(messageStatuses.holdUntil, today())),
        ),
      ),
    );
  return row?.n ?? 0;
}

export async function listRecentlyHandled(
  userId: string,
  limit = 20,
): Promise<TrackedMessageView[]> {
  const rows = await db
    .select()
    .from(messageStatuses)
    .where(and(eq(messageStatuses.userId, userId), eq(messageStatuses.status, "handled")))
    .orderBy(desc(messageStatuses.updatedAt))
    .limit(limit);
  const now = today();
  return rows.map((r) => toView(r, now));
}

export interface ActionableOptions {
  folders?: string[];
  includeUpcomingHolds?: boolean;
  newLimit?: number;
}

/**
 * What needs attention in one account: new mail (scanned over IMAP since
 * tracking started), stored `new`/`unhandled` messages and holds that are due.
 */
export async function listActionable(
  account: MailAccount,
  opts: ActionableOptions = {},
): Promise<ActionableResult> {
  const newLimit = opts.newLimit ?? 50;
  const now = today();

  const rows = await db
    .select()
    .from(messageStatuses)
    .where(
      and(
        eq(messageStatuses.userId, account.userId),
        eq(messageStatuses.accountId, account.id),
        inArray(messageStatuses.status, ["new", "unhandled", "hold"]),
      ),
    );
  const openByKey = new Map(rows.map((r) => [r.messageKey, r]));

  const scan = await scanMessagesSince(account, account.statusTrackingSince, {
    folders: opts.folders,
  });

  // Statuses of scanned messages that are already closed (handled), so they
  // are not mistaken for new.
  const scannedKeys = Array.from(
    new Set(scan.messages.map((m) => messageKey(m))),
  ).filter((k) => !openByKey.has(k));
  const closedKeys = new Set<string>();
  for (let i = 0; i < scannedKeys.length; i += 500) {
    const chunk = await rowsForKeys(account, scannedKeys.slice(i, i + 500));
    for (const r of chunk) closedKeys.add(r.messageKey);
  }

  const locations = new Map<string, Array<{ folder: string; uid: number }>>();
  // refs: what the new message answers, to find replies to open messages.
  const newByKey = new Map<string, { view: NewMessageView; refs: string[] }>();
  for (const m of scan.messages) {
    const key = messageKey(m);
    const locs = locations.get(key) ?? [];
    locs.push({ folder: m.folder, uid: m.uid });
    locations.set(key, locs);

    if (openByKey.has(key) || closedKeys.has(key) || newByKey.has(key)) continue;
    const implicit = implicitStatus(account, {
      fromAddress: m.fromAddress,
      receivedAt: m.internalDate ?? m.date,
    });
    if (implicit.status !== "new") continue;
    newByKey.set(key, {
      view: {
        accountId: account.id,
        messageId: key,
        folder: m.folder,
        uid: m.uid,
        subject: m.subject,
        from: m.from,
        date: m.internalDate ?? m.date,
        threadHold: findThreadHold(m.references, key, openByKey, now),
      },
      refs: m.references.map(normalizeMessageId),
    });
  }

  const tracked = (row: MessageStatusRow): ActionableTracked => {
    const view = toView(row, now);
    // Prefer where the scan saw the message over the snapshot taken when the
    // status was set — it may have been moved since.
    const locs = locations.get(row.messageKey);
    const current = locs?.find((l) => l.folder === row.folder && l.uid === row.uid) ?? locs?.[0];
    const newReplies = Array.from(newByKey.values())
      .filter((n) => n.refs.includes(row.messageKey))
      .map(({ view: n }) => ({
        folder: n.folder,
        uid: n.uid,
        messageId: n.messageId,
        subject: n.subject,
        from: n.from,
      }));
    return {
      ...view,
      folder: current?.folder ?? view.folder,
      uid: current?.uid ?? view.uid,
      newReplies,
    };
  };

  // Explicitly re-opened messages (status "new") join the scanned ones.
  for (const row of rows) {
    if (row.status !== "new" || newByKey.has(row.messageKey)) continue;
    const loc = locations.get(row.messageKey)?.[0];
    newByKey.set(row.messageKey, {
      view: {
        accountId: account.id,
        messageId: row.messageKey,
        folder: loc?.folder ?? row.folder,
        uid: loc?.uid ?? row.uid,
        subject: row.subject,
        from: row.fromAddress,
        date: row.messageDate?.toISOString() ?? null,
        threadHold: null,
      },
      refs: [],
    });
  }

  const allNew = Array.from(newByKey.values(), (n) => n.view).sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? ""),
  );
  const byHold = (a: ActionableTracked, b: ActionableTracked) =>
    (a.holdUntil ?? "").localeCompare(b.holdUntil ?? "");

  return {
    account: {
      id: account.id,
      label: account.label,
      email: account.email,
      statusTrackingSince: account.statusTrackingSince.toISOString(),
    },
    new: allNew.slice(0, newLimit),
    newTotal: allNew.length,
    unhandled: rows.filter((r) => r.status === "unhandled").map(tracked),
    holdDue: rows
      .filter((r) => r.status === "hold" && isHoldDue(r.holdUntil, now))
      .map(tracked)
      .sort(byHold),
    holdUpcoming: opts.includeUpcomingHolds
      ? rows
          .filter((r) => r.status === "hold" && !isHoldDue(r.holdUntil, now))
          .map(tracked)
          .sort(byHold)
      : [],
    failedFolders: scan.failedFolders,
  };
}
