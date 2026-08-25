import { and, desc, eq, inArray, lt } from "drizzle-orm";
import DOMPurify from "isomorphic-dompurify";
import { db } from "@/lib/db";
import { mailAccounts, pendingMessages, type MailAccount } from "@/lib/db/schema";
import { sendMail, type SendMailInput, type SendMailResult } from "@/lib/smtp";
import { appBaseUrl } from "@/lib/auth/oauth";
import type {
  PendingAttachmentSummary,
  PendingMessageKind,
  PendingMessagePayload,
  PendingMessageStatus,
  PendingMessageSummary,
} from "@/lib/outbox-types";

const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 24 * 30;
/** Guard against a single queued message bloating the row beyond what jsonb comfortably holds. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

export function approvalTtlHours(): number {
  const raw = Number(process.env.OUTBOX_APPROVAL_TTL_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_HOURS;
  return Math.min(Math.round(raw), MAX_TTL_HOURS);
}

export function approvalUrlFor(id: string): string {
  return `${appBaseUrl()}/outbox#msg-${id}`;
}

function sanitizeBodyHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "target", "rel", "width", "height"],
  });
}

function base64Bytes(b64: string): number {
  // 4 base64 chars encode 3 bytes; trailing '=' are padding.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function attachmentSummaries(payload: PendingMessagePayload): PendingAttachmentSummary[] {
  return (payload.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: base64Bytes(a.contentBase64),
    isInline: a.isInline ?? false,
  }));
}

type Row = typeof pendingMessages.$inferSelect;

function summarize(
  row: Row,
  account: { label: string; email: string },
): PendingMessageSummary {
  const payload = row.payload;
  return {
    id: row.id,
    accountId: row.accountId,
    accountLabel: account.label,
    accountEmail: account.email,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    to: row.toAddresses,
    cc: row.ccAddresses,
    bcc: row.bccAddresses,
    bodyText: payload.text ?? null,
    bodyHtml: payload.html ? sanitizeBodyHtml(payload.html) : null,
    includeSignature: payload.includeSignature ?? false,
    attachments: attachmentSummaries(payload),
    replyTo:
      row.replyFolder && row.replyUid !== null
        ? { folder: row.replyFolder, uid: row.replyUid }
        : null,
    requestedByClientId: row.requestedByClientId,
    decisionNote: row.decisionNote,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    approvalUrl: approvalUrlFor(row.id),
  };
}

/**
 * Flip pending rows whose deadline has passed to `expired`. Cheap enough to
 * run on every read path, which keeps the feature free of a background job.
 */
export async function expireStale(userId: string): Promise<number> {
  const rows = await db
    .update(pendingMessages)
    .set({ status: "expired", decidedAt: new Date() })
    .where(
      and(
        eq(pendingMessages.userId, userId),
        eq(pendingMessages.status, "pending"),
        lt(pendingMessages.expiresAt, new Date()),
      ),
    )
    .returning({ id: pendingMessages.id });
  return rows.length;
}

export interface QueueInput {
  userId: string;
  account: MailAccount;
  kind: PendingMessageKind;
  mail: SendMailInput;
  replyContext?: { folder: string; uid: number };
  requestedByClientId?: string | null;
}

export async function queueForApproval(input: QueueInput): Promise<PendingMessageSummary> {
  const payload: PendingMessagePayload = {
    to: input.mail.to,
    cc: input.mail.cc,
    bcc: input.mail.bcc,
    subject: input.mail.subject,
    text: input.mail.text,
    html: input.mail.html,
    inReplyTo: input.mail.inReplyTo,
    references: input.mail.references,
    includeSignature: input.mail.includeSignature,
    attachments: input.mail.attachments?.map((a) => ({
      filename: a.filename,
      contentBase64: a.contentBase64,
      contentType: a.contentType,
      contentId: a.contentId,
      isInline: a.isInline,
    })),
  };

  const attachmentBytes = (payload.attachments ?? []).reduce(
    (sum, a) => sum + base64Bytes(a.contentBase64),
    0,
  );
  if (attachmentBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Attachments total ${Math.round(attachmentBytes / 1024 / 1024)} MB, over the ${Math.round(
        MAX_PAYLOAD_BYTES / 1024 / 1024,
      )} MB limit for messages awaiting approval`,
    );
  }

  const expiresAt = new Date(Date.now() + approvalTtlHours() * 3600 * 1000);
  const [row] = await db
    .insert(pendingMessages)
    .values({
      userId: input.userId,
      accountId: input.account.id,
      kind: input.kind,
      status: "pending",
      subject: input.mail.subject,
      toAddresses: input.mail.to,
      ccAddresses: input.mail.cc ?? [],
      bccAddresses: input.mail.bcc ?? [],
      payload,
      replyFolder: input.replyContext?.folder ?? null,
      replyUid: input.replyContext?.uid ?? null,
      requestedByClientId: input.requestedByClientId ?? null,
      expiresAt,
    })
    .returning();

  return summarize(row, { label: input.account.label, email: input.account.email });
}

export interface ListOptions {
  statuses?: PendingMessageStatus[];
  limit?: number;
}

export async function listPending(
  userId: string,
  opts: ListOptions = {},
): Promise<PendingMessageSummary[]> {
  await expireStale(userId);
  const conditions = [eq(pendingMessages.userId, userId)];
  if (opts.statuses?.length) {
    conditions.push(inArray(pendingMessages.status, opts.statuses));
  }
  const rows = await db
    .select({ pending: pendingMessages, account: mailAccounts })
    .from(pendingMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, pendingMessages.accountId))
    .where(and(...conditions))
    .orderBy(desc(pendingMessages.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));

  return rows.map((r) => summarize(r.pending, r.account));
}

export async function countPending(userId: string): Promise<number> {
  await expireStale(userId);
  const rows = await db
    .select({ id: pendingMessages.id })
    .from(pendingMessages)
    .where(
      and(eq(pendingMessages.userId, userId), eq(pendingMessages.status, "pending")),
    );
  return rows.length;
}

export async function getPending(
  userId: string,
  id: string,
): Promise<PendingMessageSummary | null> {
  await expireStale(userId);
  const [row] = await db
    .select({ pending: pendingMessages, account: mailAccounts })
    .from(pendingMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, pendingMessages.accountId))
    .where(and(eq(pendingMessages.id, id), eq(pendingMessages.userId, userId)))
    .limit(1);
  if (!row) return null;
  return summarize(row.pending, row.account);
}

export class OutboxStateError extends Error {
  constructor(
    message: string,
    readonly status: PendingMessageStatus | null,
  ) {
    super(message);
    this.name = "OutboxStateError";
  }
}

async function loadRow(userId: string, id: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(pendingMessages)
    .where(and(eq(pendingMessages.id, id), eq(pendingMessages.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Explain why a guarded state transition matched no row. */
async function notPendingError(userId: string, id: string): Promise<OutboxStateError> {
  const row = await loadRow(userId, id);
  if (!row) return new OutboxStateError(`Message ${id} not found`, null);
  return new OutboxStateError(
    `Message ${id} is no longer pending (status: ${row.status})`,
    row.status,
  );
}

export interface ApproveResult {
  summary: PendingMessageSummary;
  send: SendMailResult | null;
}

/**
 * Approve and actually send. The pending → sending transition is a guarded
 * UPDATE, so two concurrent approvals (double click, two tabs) can never hand
 * the same message to SMTP twice.
 */
export async function approveAndSend(
  userId: string,
  id: string,
  note?: string,
): Promise<ApproveResult> {
  await expireStale(userId);

  const [claimed] = await db
    .update(pendingMessages)
    .set({ status: "sending", decidedAt: new Date(), decisionNote: note?.trim() || null })
    .where(
      and(
        eq(pendingMessages.id, id),
        eq(pendingMessages.userId, userId),
        eq(pendingMessages.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) throw await notPendingError(userId, id);

  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, claimed.accountId))
    .limit(1);
  if (!account) {
    const [failed] = await db
      .update(pendingMessages)
      .set({ status: "failed", errorMessage: "account no longer exists" })
      .where(eq(pendingMessages.id, id))
      .returning();
    throw new OutboxStateError(
      `Account of message ${id} no longer exists`,
      failed?.status ?? "failed",
    );
  }

  const mail: SendMailInput = { ...claimed.payload };

  try {
    const result = await sendMail(account, mail);
    const [sent] = await db
      .update(pendingMessages)
      .set({
        status: "sent",
        sentAt: new Date(),
        sendResult: result as unknown as Record<string, unknown>,
        errorMessage: null,
      })
      .where(eq(pendingMessages.id, id))
      .returning();
    return {
      summary: summarize(sent, account),
      send: result,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const [failed] = await db
      .update(pendingMessages)
      .set({ status: "failed", errorMessage: message })
      .where(eq(pendingMessages.id, id))
      .returning();
    return { summary: summarize(failed, account), send: null };
  }
}

/** Re-arm a previously failed send so the owner can approve it again. */
export async function retryFailed(userId: string, id: string): Promise<PendingMessageSummary> {
  const [row] = await db
    .update(pendingMessages)
    .set({
      status: "pending",
      decidedAt: null,
      errorMessage: null,
      expiresAt: new Date(Date.now() + approvalTtlHours() * 3600 * 1000),
    })
    .where(
      and(
        eq(pendingMessages.id, id),
        eq(pendingMessages.userId, userId),
        eq(pendingMessages.status, "failed"),
      ),
    )
    .returning();
  if (!row) {
    const existing = await loadRow(userId, id);
    if (!existing) throw new OutboxStateError(`Message ${id} not found`, null);
    throw new OutboxStateError(
      `Only failed messages can be retried (status: ${existing.status})`,
      existing.status,
    );
  }
  const [account] = await db
    .select({ label: mailAccounts.label, email: mailAccounts.email })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, row.accountId))
    .limit(1);
  return summarize(row, account ?? { label: "(deleted account)", email: "" });
}

async function decide(
  userId: string,
  id: string,
  status: Extract<PendingMessageStatus, "rejected" | "cancelled">,
  note?: string,
): Promise<PendingMessageSummary> {
  await expireStale(userId);
  const [row] = await db
    .update(pendingMessages)
    .set({ status, decidedAt: new Date(), decisionNote: note?.trim() || null })
    .where(
      and(
        eq(pendingMessages.id, id),
        eq(pendingMessages.userId, userId),
        eq(pendingMessages.status, "pending"),
      ),
    )
    .returning();
  if (!row) throw await notPendingError(userId, id);

  const [account] = await db
    .select({ label: mailAccounts.label, email: mailAccounts.email })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, row.accountId))
    .limit(1);
  return summarize(row, account ?? { label: "(deleted account)", email: "" });
}

/** The account owner declines the message — it is never handed to SMTP. */
export function rejectPending(userId: string, id: string, reason?: string) {
  return decide(userId, id, "rejected", reason);
}

/** The MCP client withdraws its own request before a decision is made. */
export function cancelPending(userId: string, id: string, reason?: string) {
  return decide(userId, id, "cancelled", reason);
}

export async function deletePending(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(pendingMessages)
    .where(and(eq(pendingMessages.id, id), eq(pendingMessages.userId, userId)))
    .returning({ id: pendingMessages.id });
  return rows.length > 0;
}
