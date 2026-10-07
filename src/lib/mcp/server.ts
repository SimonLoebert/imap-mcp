import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpContext } from "./context";
import { recipientsAllowlisted } from "@/lib/allowlist";
import {
  listUserAccounts,
  listUserCalendarAccounts,
  requireAccount,
  requireCalendarAccount,
} from "./context";
import {
  copyMessages,
  createFolder,
  deleteFolder,
  deleteMessages,
  getAttachment,
  getMessage,
  getThread,
  listFolders,
  listMessages,
  moveMessages,
  renameFolder,
  searchMessages,
  setMessageFlags,
} from "@/lib/imap";
import type { OutgoingAttachment, SendMailInput } from "@/lib/smtp";
import { sendMail } from "@/lib/smtp";
import {
  approvalTtlHours,
  cancelPending,
  getPending,
  listPending,
  queueForApproval,
} from "@/lib/outbox";
import type { PendingMessageKind, PendingMessageStatus } from "@/lib/outbox-types";

const pendingStatusEnum = z.enum([
  "pending",
  "sending",
  "sent",
  "failed",
  "rejected",
  "cancelled",
  "expired",
]);
import { signAttachmentToken } from "@/lib/auth/attachmentToken";
import { appBaseUrl } from "@/lib/auth/oauth";
import {
  createEvent,
  deleteEvent,
  findFreeSlots,
  getEvent,
  listCalendars,
  listEvents,
  updateEvent,
} from "@/lib/caldav";
import {
  createContact,
  deleteContact,
  listContacts,
  requireContact,
  updateContact,
} from "@/lib/contacts";
import { contactLimits } from "@/lib/validation/contact";

const contactEmailsSchema = z
  .array(z.string().trim().email())
  .max(contactLimits.emails)
  .describe("Email addresses, primary first. Stored lower-cased.");
const contactPhonesSchema = z
  .array(z.string().trim().min(1).max(contactLimits.phone))
  .max(contactLimits.phones)
  .describe("Phone numbers as free text, e.g. \"+49 30 1234567\".");
const contactTagsSchema = z
  .array(z.string().trim().min(1).max(contactLimits.tag))
  .max(contactLimits.tags)
  .describe("Free-form labels such as \"family\" or \"client\". Stored lower-cased.");
const contactTextSchema = (max: number, what: string) =>
  z.string().trim().max(max).nullable().optional().describe(what);

function attachmentDownloadUrl(
  userId: string,
  accountId: string,
  folder: string,
  uid: number,
  index: number,
  ttlSeconds = 15 * 60,
): { url: string; expires_at: string } {
  const token = signAttachmentToken(
    { userId, accountId, folder, uid, index },
    ttlSeconds,
  );
  return {
    url: `${appBaseUrl()}/api/attachments/${token}`,
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z
    .string()
    .min(1)
    .describe("Base64-encoded file contents. Decodes to at most ~25 MB after overhead."),
  content_type: z
    .string()
    .optional()
    .describe("MIME type. Inferred from the filename extension when omitted."),
  content_id: z
    .string()
    .optional()
    .describe("RFC 2392 Content-ID for inline references in HTML (e.g. <img src=\"cid:logo\">)."),
  is_inline: z
    .boolean()
    .optional()
    .describe("If true, attach with Content-Disposition: inline (use with content_id)."),
});

function toOutgoing(list: z.infer<typeof attachmentSchema>[] | undefined): OutgoingAttachment[] | undefined {
  if (!list?.length) return undefined;
  return list.map((a) => ({
    filename: a.filename,
    contentBase64: a.content_base64,
    contentType: a.content_type,
    contentId: a.content_id,
    isInline: a.is_inline,
  }));
}

/**
 * Single exit point for every outgoing message. When the account has
 * human-in-the-loop enabled (or the caller explicitly asked for a review),
 * the message is parked in the outbox instead of being handed to SMTP; the
 * caller gets the pending id and the URL where the owner approves it.
 *
 * `request_approval` can only ever *add* a review step — an MCP client can
 * never switch the account's own requirement off.
 */
async function dispatchOrQueue(
  ctx: McpContext,
  acc: Awaited<ReturnType<typeof requireAccount>>,
  kind: PendingMessageKind,
  mail: SendMailInput,
  opts: { requestApproval?: boolean; replyContext?: { folder: string; uid: number } } = {},
) {
  if (!opts.requestApproval) {
    if (!acc.requireSendApproval) {
      const result = await sendMail(acc, mail);
      return jsonResult({ status: "sent", ...result });
    }
    // The owner pre-approved these recipients: every To/Cc/Bcc address has to
    // be on the account's allowlist, a single outsider keeps the gate closed.
    if (recipientsAllowlisted(acc.approvalAllowlist, mail)) {
      const result = await sendMail(acc, mail);
      return jsonResult({ status: "sent", approval_skipped: "recipient_allowlist", ...result });
    }
  }

  const pending = await queueForApproval({
    userId: ctx.userId,
    account: acc,
    kind,
    mail,
    replyContext: opts.replyContext,
    requestedByClientId: ctx.clientId ?? null,
  });

  return jsonResult({
    status: "pending_approval",
    message:
      "Nothing was sent. The message is waiting for the account owner's approval — tell the user to open the approval URL below and approve or reject it. Poll get_pending_message to learn the outcome; never assume the mail went out.",
    pending_id: pending.id,
    approval_url: pending.approvalUrl,
    expires_at: pending.expiresAt,
    approval_ttl_hours: approvalTtlHours(),
    account: { id: acc.id, label: acc.label, email: acc.email },
    to: pending.to,
    cc: pending.cc,
    bcc: pending.bcc,
    subject: pending.subject,
    attachments: pending.attachments,
  });
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: msg }],
  };
}

function parseDate(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d;
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "imap-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "This server gives access to the current user's registered IMAP email accounts AND their CalDAV calendar accounts.\n\nAPPROVAL (HUMAN-IN-THE-LOOP) — accounts flagged `requireSendApproval` in list_accounts never send straight away: send_message and reply_message then return status=\"pending_approval\" with a `pending_id` and an `approval_url`, and the mail sits in the owner's outbox until they approve it in the web UI. Exception: when EVERY recipient (To, Cc and Bcc) is on the account's `approvalAllowlist` (full addresses or `@domain` entries, exact domain match only), the message is sent immediately and the response says status=\"sent\". One recipient outside the list sends the whole message to approval. Always read `status` in the response instead of predicting it. When that happens, tell the user the message is waiting and give them the approval URL — do NOT report the email as sent. Use list_pending_messages / get_pending_message to check the outcome and cancel_pending_message to withdraw a draft. While reviewing, the owner may add or remove attachments, so a message that goes out can carry different files than you supplied — read the `attachments` array of the pending message rather than assuming your own list survived.\n\nEMAIL — Call list_accounts first to discover email account IDs; the response carries each account's `writingStyleInstructions`, a pre-rendered directive you MUST follow verbatim when drafting via send_message or reply_message (it covers language, tone, formality, greeting, sign-off, length, emoji policy and custom user rules). IMAP folders are identified by their path; messages by their UID.\n\nCALENDAR — Call list_calendar_accounts to discover calendar account IDs (independent of email accounts), then list_calendars to find calendar collection URLs. Events use ETag-based optimistic concurrency: keep the `etag` returned by list_events / get_event and pass it to update_event / delete_event — a stale etag returns 412 Precondition Failed and you should re-fetch.\n\nTIMEZONES — Every event response carries `start`/`end` (UTC ISO), `startLocal`/`endLocal` (wall-clock when a TZID is set) and `tz` (IANA name, e.g. \"Europe/Paris\", or null when stored as UTC). When creating/updating events, pass `tz` to anchor the event to a real timezone — recurring events then survive DST correctly. For `start`/`end`, pass either a floating local time like \"2026-05-01T10:00:00\" interpreted in the given `tz`, or a zoned/UTC ISO (\"…Z\" / \"…+02:00\") which will be converted to the tz local time. Omit `tz` to store the event in UTC. Recurring events return their raw RRULE; pass expand_recurring=true on list_events to expand individual occurrences within the requested time range.\n\nCONTACTS — The user keeps an address book of the people they write to regularly. When the user names a recipient (\"mail Anna\"), look the person up with list_contacts and use the stored address instead of guessing one; if several contacts match, ask which one. A contact's `salutation` says how to greet them and overrides the writing style's default greeting for that recipient; `notes` carry context the user wants you to know. Before create_contact, search by address first — an address can belong to only one contact, so a duplicate is refused with the existing contact's id. Contacts are independent of the mail accounts: saving a contact never sends anything, and a contact's address still goes through the normal approval gate.",
    },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List email accounts",
      description:
        "List the IMAP/SMTP email accounts configured by the current user. `requireSendApproval` says whether sends are held for the owner's approval; `approvalAllowlist` lists the addresses and `@domain`s that skip that approval — only when every recipient of a message is on it. Only the owner can change either, in the web UI.",
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await listUserAccounts(ctx.userId);
        return jsonResult({ accounts: rows });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_folders",
    {
      title: "List IMAP folders",
      description: "List the folders (mailboxes) of an account.",
      inputSchema: {
        account_id: z.string().uuid().describe("Account ID returned by list_accounts"),
      },
    },
    async ({ account_id }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const folders = await listFolders(acc);
        return jsonResult({ folders });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages in folder",
      description:
        "List message headers in a folder (default: the 50 most recent).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(200).optional(),
        since: z.string().optional().describe("ISO date — only messages after this date"),
        unread_only: z.boolean().optional(),
      },
    },
    async ({ account_id, folder, limit, since, unread_only }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const messages = await listMessages(acc, {
          folder,
          limit,
          since: parseDate(since),
          unreadOnly: unread_only,
        });
        return jsonResult({ messages });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_message",
    {
      title: "Get full message",
      description:
        "Fetch a full message (headers, text, HTML, attachment metadata).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uid: z.number().int().positive(),
      },
    },
    async ({ account_id, folder, uid }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const msg = await getMessage(acc, folder, uid);
        if (!msg) return errorResult(new Error("message not found"));
        const enriched = {
          ...msg,
          attachments: msg.attachments.map((a) => ({
            ...a,
            ...attachmentDownloadUrl(ctx.userId, account_id, folder, uid, a.index),
          })),
        };
        return jsonResult({ message: enriched });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "IMAP search (from, to, subject, body, date ranges, unread only).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string().default("INBOX"),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        unread_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const acc = await requireAccount(ctx.userId, args.account_id);
        const messages = await searchMessages(acc, {
          folder: args.folder,
          from: args.from,
          to: args.to,
          subject: args.subject,
          body: args.body,
          dateFrom: parseDate(args.date_from),
          dateTo: parseDate(args.date_to),
          unreadOnly: args.unread_only,
          limit: args.limit,
        });
        return jsonResult({ messages });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send email",
      description:
        "Send an email through the account's SMTP. Before drafting, call list_accounts and follow the chosen account's `writingStyleInstructions` verbatim — it encodes language, tone, greetings, length and any custom rules the user configured. The HTML signature is appended when include_signature=true. File attachments are accepted as base64. A copy of the sent message is IMAP-appended to the Sent folder for every provider except Gmail (which already saves to Sent through SMTP).\n\nHUMAN-IN-THE-LOOP — when the account has `requireSendApproval` (see list_accounts), NOTHING is sent here: the draft is parked in the owner's outbox and the response comes back with status=\"pending_approval\" plus a `pending_id` and an `approval_url`. Hand that URL to the user, state plainly that the mail has NOT gone out yet, and check get_pending_message for the outcome. The owner can also attach further files to the draft on that page before approving it, so don't ask the user to re-queue a message just to add an attachment. Exception: if every To/Cc/Bcc recipient is covered by the account's `approvalAllowlist` (see list_accounts), the message is sent immediately with status=\"sent\"; a single recipient outside it queues the whole message. `request_approval: true` always queues. Never claim a message was sent unless the response says status=\"sent\".",
      inputSchema: {
        account_id: z.string().uuid(),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string(),
        body_text: z.string().optional(),
        body_html: z.string().optional(),
        include_signature: z.boolean().default(true),
        attachments: z.array(attachmentSchema).optional(),
        request_approval: z
          .boolean()
          .optional()
          .describe(
            "Force the human approval step even when the account does not require it or all recipients are allowlisted. Cannot disable an account's own approval requirement.",
          ),
      },
    },
    async (args) => {
      try {
        if (!args.body_text && !args.body_html) {
          return errorResult(new Error("body_text or body_html required"));
        }
        const acc = await requireAccount(ctx.userId, args.account_id);
        return await dispatchOrQueue(
          ctx,
          acc,
          "send",
          {
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            text: args.body_text,
            html: args.body_html,
            includeSignature: args.include_signature,
            attachments: toOutgoing(args.attachments),
          },
          { requestApproval: args.request_approval },
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "reply_message",
    {
      title: "Reply to message",
      description:
        "Reply to an existing message (preserves In-Reply-To and References, quotes the original when quote_original=true). Follow the account's `writingStyleInstructions` from list_accounts when drafting the body. The reply is IMAP-appended to Sent (skipped on Gmail).\n\nHUMAN-IN-THE-LOOP — same approval gate as send_message: when the account has `requireSendApproval`, the reply is only queued (status=\"pending_approval\") and the owner must approve it at `approval_url` before it leaves the server — unless every recipient is on the account's `approvalAllowlist`, in which case it is sent at once (status=\"sent\"). With reply_all, Cc recipients count too.",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uid: z.number().int().positive(),
        body_text: z.string().optional(),
        body_html: z.string().optional(),
        include_signature: z.boolean().default(true),
        quote_original: z.boolean().default(true),
        reply_all: z.boolean().default(false),
        attachments: z.array(attachmentSchema).optional(),
        request_approval: z
          .boolean()
          .optional()
          .describe(
            "Force the human approval step even when the account does not require it or all recipients are allowlisted. Cannot disable an account's own approval requirement.",
          ),
      },
    },
    async (args) => {
      try {
        if (!args.body_text && !args.body_html) {
          return errorResult(new Error("body_text or body_html required"));
        }
        const acc = await requireAccount(ctx.userId, args.account_id);
        const original = await getMessage(acc, args.folder, args.uid);
        if (!original) return errorResult(new Error("original message not found"));

        const to = original.from
          ? [extractAddress(original.from)]
          : [];
        const cc = args.reply_all ? original.cc.map(extractAddress).filter(Boolean) : undefined;

        const subject = original.subject
          ? original.subject.toLowerCase().startsWith("re:")
            ? original.subject
            : `Re: ${original.subject}`
          : "Re:";

        const refs = [...original.references];
        if (original.messageId) refs.push(original.messageId);

        let bodyText = args.body_text;
        let bodyHtml = args.body_html;
        if (args.quote_original) {
          const quoteHeader = `\n\nOn ${original.date ?? ""}, ${original.from ?? ""} wrote:\n`;
          if (bodyText && original.text) {
            const quoted = original.text
              .split("\n")
              .map((l) => `> ${l}`)
              .join("\n");
            bodyText = `${bodyText}${quoteHeader}${quoted}`;
          }
          if (bodyHtml && original.html) {
            bodyHtml = `${bodyHtml}<blockquote style="border-left:2px solid #ccc;padding-left:8px;margin-left:0">${original.html}</blockquote>`;
          }
        }

        return await dispatchOrQueue(
          ctx,
          acc,
          "reply",
          {
            to: to.filter(Boolean) as string[],
            cc,
            subject,
            text: bodyText,
            html: bodyHtml,
            includeSignature: args.include_signature,
            inReplyTo: original.messageId ?? undefined,
            references: refs.filter(Boolean),
            attachments: toOutgoing(args.attachments),
          },
          {
            requestApproval: args.request_approval,
            replyContext: { folder: args.folder, uid: args.uid },
          },
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_pending_messages",
    {
      title: "List messages awaiting approval",
      description:
        "List the outgoing messages held in the human-in-the-loop outbox, newest first. Use it to check whether a draft you queued has been approved, rejected or has expired. Defaults to the ones still awaiting a decision. Attachment lists can have been edited by the owner during review — see get_pending_message.",
      inputSchema: {
        status: z
          .array(pendingStatusEnum)
          .optional()
          .describe(
            "Filter by status. Defaults to [\"pending\"]. Possible values: pending, sending, sent, failed, rejected, cancelled, expired.",
          ),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ status, limit }) => {
      try {
        const statuses: PendingMessageStatus[] = status?.length ? status : ["pending"];
        const rows = await listPending(ctx.userId, { statuses, limit });
        return jsonResult({
          approval_ttl_hours: approvalTtlHours(),
          count: rows.length,
          messages: rows,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_pending_message",
    {
      title: "Get an outbox message",
      description:
        "Return one queued message with its full body, recipients and current status. This is how you find out what the account owner decided about a draft you submitted — status \"sent\" means it really went out, \"rejected\"/\"cancelled\"/\"expired\" mean it never did, and \"failed\" means it was approved but SMTP refused it (see error_message).\n\nThe `attachments` array reflects the message as it stands now, not as you queued it: the owner can attach further files or drop yours while it waits. Each entry carries `addedBy` (\"client\" = supplied by you, \"user\" = added by the owner in the web UI). Never state what a message was sent with without re-reading this array.",
      inputSchema: {
        pending_id: z.string().uuid().describe("The pending_id returned by send_message / reply_message"),
      },
    },
    async ({ pending_id }) => {
      try {
        const row = await getPending(ctx.userId, pending_id);
        if (!row) return errorResult(new Error(`Pending message ${pending_id} not found`));
        return jsonResult(row);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "cancel_pending_message",
    {
      title: "Withdraw a message awaiting approval",
      description:
        "Withdraw a draft you queued before the owner decides on it — for instance when the user changed their mind or you want to submit a corrected version. Only works while the message is still pending; approving is the owner's job and cannot be done from here.",
      inputSchema: {
        pending_id: z.string().uuid(),
        reason: z.string().max(500).optional().describe("Shown to the owner in the outbox history."),
      },
    },
    async ({ pending_id, reason }) => {
      try {
        const row = await cancelPending(ctx.userId, pending_id, reason);
        return jsonResult({ status: "cancelled", message: row });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get full conversation thread",
      description:
        "Return every message in the same conversation as the anchor message, sorted oldest → newest. Uses Gmail's X-GM-THRID when available (fast, reliable) and falls back to walking the RFC 5322 References / Message-ID chain for generic IMAP. By default searches only the given folder; pass cross_folder=true to scan every mailbox (useful to pick up Sent replies in non-Gmail accounts — on Gmail the All Mail label already contains everything).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uid: z.number().int().positive(),
        cross_folder: z
          .boolean()
          .default(false)
          .describe("Search all mailboxes on the server instead of just the current folder."),
        max_messages: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Cap on the number of messages returned."),
      },
    },
    async ({ account_id, folder, uid, cross_folder, max_messages }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const thread = await getThread(acc, folder, uid, {
          crossFolder: cross_folder,
          maxMessages: max_messages,
        });
        if (!thread) return errorResult(new Error("anchor message not found"));
        const enriched = {
          strategy: thread.strategy,
          threadId: thread.threadId,
          truncated: thread.truncated,
          count: thread.messages.length,
          messages: thread.messages.map((m) => ({
            ...m,
            attachments: m.attachments.map((a) => ({
              ...a,
              ...attachmentDownloadUrl(
                ctx.userId,
                account_id,
                m.folder,
                m.uid,
                a.index,
              ),
            })),
          })),
        };
        return jsonResult(enriched);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get an attachment download URL",
      description:
        "Return a short-lived (15 min) signed HTTPS URL that the user can click to download the attachment. Images are additionally embedded as image content so Claude can preview them inline. The file is never stored on the server — it's streamed from IMAP on demand. Call get_message first to discover attachment indexes — the URL is also available there. Use inline_blob=true to also return the raw base64 (capped by max_size_mb) for clients that handle embedded resources natively.",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uid: z.number().int().positive(),
        attachment_index: z
          .number()
          .int()
          .min(0)
          .describe("Zero-based index from get_message's attachments array"),
        inline_blob: z
          .boolean()
          .default(false)
          .describe("Also return the raw base64 as an embedded MCP resource (off by default to keep payloads small)."),
        max_size_mb: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Cap applied when inline_blob=true."),
      },
    },
    async ({ account_id, folder, uid, attachment_index, inline_blob, max_size_mb }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const att = await getAttachment(acc, folder, uid, attachment_index);
        if (!att) return errorResult(new Error("attachment not found"));

        const dl = attachmentDownloadUrl(
          ctx.userId,
          account_id,
          folder,
          uid,
          attachment_index,
        );

        const summary = {
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          contentId: att.contentId,
          isInline: att.isInline,
          download_url: dl.url,
          expires_at: dl.expires_at,
        };

        const isImage = att.contentType.toLowerCase().startsWith("image/");
        type Item =
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
          | {
              type: "resource";
              resource: { uri: string; mimeType: string; blob: string };
            };
        const content: Item[] = [
          { type: "text", text: JSON.stringify(summary, null, 2) },
        ];

        if (isImage) {
          content.push({
            type: "image",
            data: att.base64,
            mimeType: att.contentType,
          });
        }

        if (inline_blob && !isImage) {
          const maxBytes = max_size_mb * 1024 * 1024;
          if (att.size > maxBytes) {
            return errorResult(
              new Error(
                `inline_blob requested but attachment is ${Math.round(att.size / 1024 / 1024)} MB, over the ${max_size_mb} MB limit — raise max_size_mb or rely on download_url`,
              ),
            );
          }
          const uri = `mail-attachment://${account_id}/${encodeURIComponent(folder)}/${uid}/${attachment_index}`;
          content.push({
            type: "resource",
            resource: { uri, mimeType: att.contentType, blob: att.base64 },
          });
        }

        return { content };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark as read",
      description: "Mark one or more messages as read (adds the \\Seen flag).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await setMessageFlags(acc, folder, uids, { add: ["\\Seen"] });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "mark_unread",
    {
      title: "Mark as unread",
      description: "Mark one or more messages as unread (removes the \\Seen flag).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await setMessageFlags(acc, folder, uids, { remove: ["\\Seen"] });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "flag_messages",
    {
      title: "Flag messages (star)",
      description:
        "Star / flag one or more messages by adding the \\Flagged marker (equivalent to Gmail's star).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await setMessageFlags(acc, folder, uids, { add: ["\\Flagged"] });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "unflag_messages",
    {
      title: "Remove flag (unstar)",
      description: "Remove the \\Flagged marker (unstar).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await setMessageFlags(acc, folder, uids, { remove: ["\\Flagged"] });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "set_flags",
    {
      title: "Add/remove arbitrary IMAP flags",
      description:
        "Advanced: add and/or remove arbitrary IMAP flags (\\Seen, \\Flagged, \\Answered, $Important, custom labels, …).",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    async ({ account_id, folder, uids, add, remove }) => {
      try {
        if (!add?.length && !remove?.length) {
          return errorResult(new Error("at least one of add/remove must be non-empty"));
        }
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await setMessageFlags(acc, folder, uids, { add, remove });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "move_messages",
    {
      title: "Move messages",
      description: "Move messages from one folder to another (destination assigns new UIDs).",
      inputSchema: {
        account_id: z.string().uuid(),
        from_folder: z.string(),
        to_folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, from_folder, to_folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await moveMessages(acc, from_folder, uids, to_folder);
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "copy_messages",
    {
      title: "Copy messages",
      description: "Copy messages to another folder without removing them from the source.",
      inputSchema: {
        account_id: z.string().uuid(),
        from_folder: z.string(),
        to_folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
      },
    },
    async ({ account_id, from_folder, to_folder, uids }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await copyMessages(acc, from_folder, uids, to_folder);
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "delete_messages",
    {
      title: "Delete messages",
      description:
        "Delete messages. Defaults to moving them to the Trash folder; set permanent=true for an immediate and irreversible expunge.",
      inputSchema: {
        account_id: z.string().uuid(),
        folder: z.string(),
        uids: z.array(z.number().int().positive()).min(1),
        permanent: z
          .boolean()
          .default(false)
          .describe("If true, expunge instead of moving to Trash."),
      },
    },
    async ({ account_id, folder, uids, permanent }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await deleteMessages(acc, folder, uids, { permanent });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create folder",
      description:
        "Create a new IMAP folder. Paths may be hierarchical (e.g. 'Archives/2026').",
      inputSchema: {
        account_id: z.string().uuid(),
        path: z.string().min(1),
      },
    },
    async ({ account_id, path }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await createFolder(acc, path);
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "rename_folder",
    {
      title: "Rename folder",
      description: "Rename or reparent a folder.",
      inputSchema: {
        account_id: z.string().uuid(),
        from_path: z.string().min(1),
        to_path: z.string().min(1),
      },
    },
    async ({ account_id, from_path, to_path }) => {
      try {
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await renameFolder(acc, from_path, to_path);
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete folder",
      description:
        "Delete an IMAP folder (warning: usually irreversible on the server). INBOX is rejected.",
      inputSchema: {
        account_id: z.string().uuid(),
        path: z.string().min(1),
      },
    },
    async ({ account_id, path }) => {
      try {
        if (path.toUpperCase() === "INBOX") {
          return errorResult(new Error("cannot delete INBOX"));
        }
        const acc = await requireAccount(ctx.userId, account_id);
        const res = await deleteFolder(acc, path);
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Calendar (CalDAV) tools
  // ──────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_calendar_accounts",
    {
      title: "List calendar accounts",
      description:
        "List the CalDAV calendar accounts configured by the current user. These are independent of email accounts.",
      inputSchema: {},
    },
    async () => {
      try {
        const rows = await listUserCalendarAccounts(ctx.userId);
        return jsonResult({ calendar_accounts: rows });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description:
        "List the calendar collections available on a CalDAV account. Use the returned `url` as `calendar_url` in subsequent tools.",
      inputSchema: {
        account_id: z
          .string()
          .uuid()
          .describe("Calendar account ID returned by list_calendar_accounts"),
      },
    },
    async ({ account_id }) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, account_id);
        const calendars = await listCalendars(acc);
        return jsonResult({ calendars });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_events",
    {
      title: "List calendar events",
      description:
        "List events in a calendar over a time window. Returns each event's `url` and `etag` (needed for update_event / delete_event). Recurring events are returned once (the master) with their raw RRULE; pass expand_recurring=true to also receive an `occurrences[]` array expanded within the requested range.",
      inputSchema: {
        account_id: z.string().uuid(),
        calendar_url: z
          .string()
          .url()
          .describe("Calendar collection URL from list_calendars"),
        time_min: z.string().describe("ISO 8601 datetime — lower bound (inclusive)"),
        time_max: z.string().describe("ISO 8601 datetime — upper bound (exclusive)"),
        expand_recurring: z.boolean().default(false),
      },
    },
    async ({ account_id, calendar_url, time_min, time_max, expand_recurring }) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, account_id);
        const tMin = parseDate(time_min);
        const tMax = parseDate(time_max);
        if (!tMin || !tMax) throw new Error("time_min and time_max are required");
        const result = await listEvents(acc, {
          calendarUrl: calendar_url,
          timeMin: tMin,
          timeMax: tMax,
          expandRecurring: expand_recurring,
        });
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Get a single event",
      description:
        "Fetch a single event by its calendar URL + event URL. Returns the parsed event plus the raw iCalendar string.",
      inputSchema: {
        account_id: z.string().uuid(),
        calendar_url: z.string().url(),
        event_url: z.string().url(),
      },
    },
    async ({ account_id, calendar_url, event_url }) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, account_id);
        const r = await getEvent(acc, calendar_url, event_url);
        if (!r) return errorResult(new Error("event not found"));
        return jsonResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const attendeeInputSchema = z.object({
    email: z.string().email(),
    name: z.string().optional(),
    role: z
      .enum(["REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT", "CHAIR"])
      .optional(),
    rsvp: z.boolean().optional(),
  });

  const reminderInputSchema = z.object({
    minutes_before: z.number().int().min(0).max(40320),
    action: z.enum(["DISPLAY", "EMAIL", "AUDIO"]).optional(),
  });

  server.registerTool(
    "create_event",
    {
      title: "Create a calendar event",
      description:
        "Create a new event. When `tz` (IANA name) is provided, `start`/`end` may be a floating local time (\"2026-05-01T10:00:00\") interpreted in `tz`, or a zoned/UTC ISO that gets converted to `tz` local time; the event is stored with TZID, which keeps recurring events DST-correct. Omit `tz` to store in UTC (`Z`). For all_day=true, pass YYYY-MM-DD strings. Returns the new event `url` and `etag`.",
      inputSchema: {
        account_id: z.string().uuid(),
        calendar_url: z.string().url(),
        summary: z.string().min(1),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z
          .string()
          .describe(
            "ISO 8601 datetime (floating, zoned or UTC), or YYYY-MM-DD when all_day",
          ),
        end: z
          .string()
          .describe(
            "ISO 8601 datetime (floating, zoned or UTC), or YYYY-MM-DD when all_day",
          ),
        all_day: z.boolean().default(false),
        tz: z
          .string()
          .optional()
          .describe(
            "IANA timezone name (e.g. \"Europe/Paris\"). When set, the event is stored with TZID and recurrences stay correct across DST.",
          ),
        attendees: z.array(attendeeInputSchema).optional(),
        organizer_email: z.string().email().optional(),
        rrule: z
          .string()
          .optional()
          .describe(
            "RFC 5545 RRULE without the leading 'RRULE:' (e.g. 'FREQ=WEEKLY;BYDAY=MO,WE')",
          ),
        reminders: z.array(reminderInputSchema).optional(),
        status: z.enum(["TENTATIVE", "CONFIRMED", "CANCELLED"]).optional(),
      },
    },
    async (args) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, args.account_id);
        const result = await createEvent(acc, args.calendar_url, {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          allDay: args.all_day,
          tz: args.tz,
          attendees: args.attendees,
          organizerEmail: args.organizer_email,
          rrule: args.rrule,
          reminders: args.reminders?.map((r) => ({
            minutesBefore: r.minutes_before,
            action: r.action,
          })),
          status: args.status,
        });
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "update_event",
    {
      title: "Update a calendar event",
      description:
        "Patch an existing event. The `etag` is REQUIRED — get it from list_events or get_event. A stale etag returns a 412 error; in that case re-fetch the event and retry. Only the fields you pass are modified; pass null to description/location/rrule to clear them. `tz` follows the same semantics as create_event — pass an IANA name to anchor the event to a timezone, pass null to switch to UTC, or omit to keep the existing TZID. Omitting `start`/`end` while changing `tz` re-anchors the existing wall-clock to the new zone.",
      inputSchema: {
        account_id: z.string().uuid(),
        calendar_url: z.string().url(),
        event_url: z.string().url(),
        etag: z.string().min(1),
        summary: z.string().optional(),
        description: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        all_day: z.boolean().optional(),
        tz: z.string().nullable().optional(),
        attendees: z.array(attendeeInputSchema).optional(),
        rrule: z.string().nullable().optional(),
        status: z.enum(["TENTATIVE", "CONFIRMED", "CANCELLED"]).optional(),
      },
    },
    async (args) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, args.account_id);
        const result = await updateEvent(acc, args.calendar_url, args.event_url, args.etag, {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          allDay: args.all_day,
          tz: args.tz,
          attendees: args.attendees,
          rrule: args.rrule,
          status: args.status,
        });
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete a calendar event",
      description:
        "Delete an event by its URL. Pass `etag` for safe optimistic-concurrency deletion (a stale etag returns 412); omit it to force-delete.",
      inputSchema: {
        account_id: z.string().uuid(),
        event_url: z.string().url(),
        etag: z.string().optional(),
      },
    },
    async ({ account_id, event_url, etag }) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, account_id);
        const result = await deleteEvent(acc, event_url, etag);
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "find_free_slots",
    {
      title: "Find free time slots",
      description:
        "Find free time slots across one or more calendars within a window. Recurring events are expanded automatically. Optionally restrict to working hours.",
      inputSchema: {
        account_id: z.string().uuid(),
        calendar_urls: z.array(z.string().url()).min(1),
        time_min: z.string(),
        time_max: z.string(),
        duration_minutes: z.number().int().min(5).max(60 * 24),
        work_hours: z
          .object({
            start: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .describe("HH:MM wall-clock in `tz` (UTC if tz omitted)"),
            end: z
              .string()
              .regex(/^\d{2}:\d{2}$/)
              .describe("HH:MM wall-clock in `tz` (UTC if tz omitted)"),
            tz: z
              .string()
              .optional()
              .describe(
                "IANA timezone name. Working hours are evaluated as wall-clock in this zone, so they stay aligned across DST.",
              ),
            days: z
              .array(z.number().int().min(0).max(6))
              .optional()
              .describe("0=Sunday … 6=Saturday. Defaults to Mon-Fri."),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        const acc = await requireCalendarAccount(ctx.userId, args.account_id);
        const tMin = parseDate(args.time_min);
        const tMax = parseDate(args.time_max);
        if (!tMin || !tMax) throw new Error("time_min and time_max are required");
        const slots = await findFreeSlots(acc, {
          calendarUrls: args.calendar_urls,
          timeMin: tMin,
          timeMax: tMax,
          durationMinutes: args.duration_minutes,
          workHours: args.work_hours,
        });
        return jsonResult({ free_slots: slots });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_contacts",
    {
      title: "List or search contacts",
      description:
        "List the user's address book, sorted by name. `query` is a case-insensitive substring match over name, email addresses, organization, tags and notes; `email` finds the contact owning an exact address (use it to identify the sender of a message). Filters combine with AND. Results are paged: when `has_more` is true, call again with a higher `offset`. An empty result only means no contact matches — it does not mean the person does not exist, so ask the user for the address rather than guessing one.",
      inputSchema: {
        query: z.string().max(200).optional(),
        email: z.string().trim().email().optional(),
        tag: z.string().max(contactLimits.tag).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ query, email, tag, limit, offset }) => {
      try {
        const result = await listContacts(ctx.userId, { query, email, tag, limit, offset });
        return jsonResult({ contacts: result.contacts, has_more: result.hasMore });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get a contact",
      description: "Fetch one address-book entry by its ID (from list_contacts).",
      inputSchema: {
        contact_id: z.string().uuid(),
      },
    },
    async ({ contact_id }) => {
      try {
        const contact = await requireContact(ctx.userId, contact_id);
        return jsonResult({ contact });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "create_contact",
    {
      title: "Create a contact",
      description:
        "Add a person to the user's address book. Only `name` is required. Each email address can belong to only one contact: if one of the addresses is already stored, nothing is created and the error names the existing contact — call update_contact on that ID instead. Search with list_contacts (`email`) first. Only save details the user gave you or that appear in their mail; do not invent addresses, phone numbers or salutations.",
      inputSchema: {
        name: z.string().trim().min(1).max(contactLimits.name).describe("Display name, e.g. \"Anna Schmidt\""),
        emails: contactEmailsSchema.optional(),
        phones: contactPhonesSchema.optional(),
        organization: contactTextSchema(contactLimits.shortText, "Company or organization"),
        job_title: contactTextSchema(contactLimits.shortText, "Role at the organization"),
        salutation: contactTextSchema(
          contactLimits.salutation,
          "How to open a mail to this person, e.g. \"Hallo Anna\" or \"Sehr geehrter Herr Weber\"",
        ),
        notes: contactTextSchema(contactLimits.notes, "Free-text context about the person"),
        tags: contactTagsSchema.optional(),
      },
    },
    async (args) => {
      try {
        const contact = await createContact(ctx.userId, {
          name: args.name,
          emails: args.emails,
          phones: args.phones,
          organization: args.organization,
          jobTitle: args.job_title,
          salutation: args.salutation,
          notes: args.notes,
          tags: args.tags,
        });
        return jsonResult({ contact });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update a contact",
      description:
        "Change an existing contact. Omitted fields stay as they are; `null` clears a text field. The arrays `emails`, `phones` and `tags` REPLACE the stored list — they are not merged. To add one address, call get_contact first and pass the full list including the existing entries, or the existing ones are lost. An address that already belongs to a different contact is refused. Returns the contact as stored after the change.",
      inputSchema: {
        contact_id: z.string().uuid(),
        name: z.string().trim().min(1).max(contactLimits.name).optional(),
        emails: contactEmailsSchema.optional(),
        phones: contactPhonesSchema.optional(),
        organization: contactTextSchema(contactLimits.shortText, "Company or organization"),
        job_title: contactTextSchema(contactLimits.shortText, "Role at the organization"),
        salutation: contactTextSchema(contactLimits.salutation, "How to open a mail to this person"),
        notes: contactTextSchema(contactLimits.notes, "Free-text context; replaces the existing notes"),
        tags: contactTagsSchema.optional(),
      },
    },
    async (args) => {
      try {
        const contact = await updateContact(ctx.userId, args.contact_id, {
          name: args.name,
          emails: args.emails,
          phones: args.phones,
          organization: args.organization,
          jobTitle: args.job_title,
          salutation: args.salutation,
          notes: args.notes,
          tags: args.tags,
        });
        if (!contact) throw new Error(`Contact ${args.contact_id} not found for current user`);
        return jsonResult({ contact });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "delete_contact",
    {
      title: "Delete a contact",
      description:
        "Permanently remove a contact from the address book. There is no undo and no trash — only call this when the user explicitly asked for the contact to be deleted. Mail already exchanged with the person is not affected.",
      inputSchema: {
        contact_id: z.string().uuid(),
      },
    },
    async ({ contact_id }) => {
      try {
        const ok = await deleteContact(ctx.userId, contact_id);
        if (!ok) throw new Error(`Contact ${contact_id} not found for current user`);
        return jsonResult({ deleted: true, contact_id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

function extractAddress(field: string): string {
  const m = field.match(/<([^>]+)>/);
  if (m) return m[1];
  return field.trim();
}
