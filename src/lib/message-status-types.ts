/**
 * Processing status of a received message, shared by schema, MCP server, REST
 * API and the status dashboard.
 *
 * - `new`       — nobody has told the user about it yet.
 * - `unhandled` — the user knows, a reply is still owed.
 * - `handled`   — done (answered, or nothing to do).
 * - `hold`      — parked until `holdUntil`: answer later, or check back then
 *                 whether the other side replied.
 */
export const MESSAGE_STATUSES = ["new", "unhandled", "handled", "hold"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Where a status comes from: `stored` was set explicitly; `implicit_*` is the
 * default for a message nobody has touched yet.
 */
export type MessageStatusSource =
  | "stored"
  | "implicit_new"
  | "implicit_before_tracking"
  | "implicit_own_message";

/** A held message elsewhere in the same thread (it is referenced by this one). */
export interface ThreadHold {
  messageId: string;
  folder: string;
  uid: number;
  subject: string | null;
  holdUntil: string;
  holdDue: boolean;
  note: string | null;
}

/** A stored status row as the dashboard sees it. */
export interface TrackedMessageView {
  id: string;
  accountId: string;
  messageId: string;
  status: MessageStatus;
  holdUntil: string | null;
  holdDue: boolean;
  note: string | null;
  folder: string;
  uid: number;
  subject: string | null;
  fromAddress: string | null;
  messageDate: string | null;
  updatedAt: string;
}

/** A message that has no stored status and therefore counts as new. */
export interface NewMessageView {
  accountId: string;
  messageId: string;
  folder: string;
  uid: number;
  subject: string | null;
  from: string | null;
  date: string | null;
  threadHold: ThreadHold | null;
}

export type ActionableTracked = TrackedMessageView & {
  /** New messages that answer this one — for a hold, the reply you were waiting for. */
  newReplies: Array<{
    folder: string;
    uid: number;
    messageId: string;
    subject: string | null;
    from: string | null;
  }>;
};

export interface ActionableResult {
  account: { id: string; label: string; email: string; statusTrackingSince: string };
  new: NewMessageView[];
  newTotal: number;
  unhandled: ActionableTracked[];
  holdDue: ActionableTracked[];
  /** Holds whose date has not come yet; only filled when asked for. */
  holdUpcoming: ActionableTracked[];
  failedFolders: string[];
}
