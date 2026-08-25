/**
 * Types shared between the database schema, the MCP server, the REST API and
 * the React components of the approval UI. Kept free of server-only imports
 * so client components can import them safely.
 */

export type PendingMessageKind = "send" | "reply";

export type PendingMessageStatus =
  /** Waiting for the account owner's decision. */
  | "pending"
  /** Approved and currently being handed to SMTP. */
  | "sending"
  /** Approved and handed to SMTP successfully. */
  | "sent"
  /** Approved, but SMTP refused it — inspect `errorMessage`. */
  | "failed"
  /** The owner declined it; the message was never handed to SMTP. */
  | "rejected"
  /** The MCP client withdrew its own request before a decision was made. */
  | "cancelled"
  /** Nobody decided within the approval TTL. */
  | "expired";

export const PENDING_STATUSES: readonly PendingMessageStatus[] = [
  "pending",
  "sending",
  "sent",
  "failed",
  "rejected",
  "cancelled",
  "expired",
] as const;

export interface PendingAttachment {
  filename: string;
  contentBase64: string;
  contentType?: string;
  contentId?: string;
  isInline?: boolean;
}

/** Everything needed to send the message verbatim once it is approved. */
export interface PendingMessagePayload {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  includeSignature?: boolean;
  attachments?: PendingAttachment[];
}

/** Attachment metadata without the base64 blob. */
export interface PendingAttachmentSummary {
  filename: string;
  contentType?: string;
  sizeBytes: number;
  isInline: boolean;
}

/**
 * What the UI and the MCP tools get to see: never the raw attachment bytes,
 * and the HTML body already sanitized for display.
 */
export interface PendingMessageSummary {
  id: string;
  accountId: string;
  accountLabel: string;
  accountEmail: string;
  kind: PendingMessageKind;
  status: PendingMessageStatus;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  includeSignature: boolean;
  attachments: PendingAttachmentSummary[];
  replyTo: { folder: string; uid: number } | null;
  requestedByClientId: string | null;
  decisionNote: string | null;
  errorMessage: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  sentAt: string | null;
  approvalUrl: string;
}

export function isTerminalStatus(status: PendingMessageStatus): boolean {
  return status !== "pending";
}
