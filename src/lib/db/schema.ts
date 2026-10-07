import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { WritingStyle } from "@/lib/writing-style";
import type {
  PendingMessageKind,
  PendingMessagePayload,
  PendingMessageStatus,
} from "@/lib/outbox-types";
import type { MessageStatus } from "@/lib/message-status-types";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_clerk_user_id_idx").on(t.clerkUserId)],
);

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    email: text("email").notNull(),
    fromName: text("from_name"),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecure: boolean("imap_secure").notNull().default(true),
    imapUser: text("imap_user").notNull(),
    imapPasswordEnc: text("imap_password_enc").notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    smtpUser: text("smtp_user").notNull(),
    smtpPasswordEnc: text("smtp_password_enc").notNull(),
    signatureHtml: text("signature_html"),
    writingStyle: jsonb("writing_style").$type<WritingStyle>(),
    /**
     * Human-in-the-loop switch. When true (the default), messages the MCP
     * client asks to send are parked in the outbox and only leave the server
     * once the account owner approves them in the web UI.
     */
    requireSendApproval: boolean("require_send_approval").notNull().default(true),
    /**
     * Recipients that skip the approval gate: full addresses or `@domain`
     * entries (see src/lib/allowlist.ts). Only honoured when every recipient
     * of a message is covered.
     */
    approvalAllowlist: text("approval_allowlist").array().notNull().default([]),
    /**
     * OpenPGP identity of the account (see src/lib/pgp.ts). The private key is
     * stored unlocked (no passphrase) as armored text, encrypted with the
     * master key like the passwords. Generated on first use when signing is on
     * and no key was imported.
     */
    pgpPrivateKeyEnc: text("pgp_private_key_enc"),
    pgpPublicKey: text("pgp_public_key"),
    pgpFingerprint: text("pgp_fingerprint"),
    /** Sign outgoing mail as PGP/MIME (RFC 3156) unless a send asks otherwise. */
    pgpSignByDefault: boolean("pgp_sign_by_default").notNull().default(true),
    /** Attach the public key (`OpenPGP_0x….asc`) to outgoing mail. */
    pgpAttachPublicKey: boolean("pgp_attach_public_key").notNull().default(true),
    /**
     * Encrypt outgoing mail automatically whenever every recipient has a
     * usable key in the user's keyring (`pgp_keys`). A send can still demand
     * or refuse encryption explicitly.
     */
    pgpAutoEncrypt: boolean("pgp_auto_encrypt").notNull().default(true),
    /**
     * Keys this account used before the current one, each encrypted like
     * `pgpPrivateKeyEnc`. Kept only to decrypt mail sent to an older key.
     */
    pgpPreviousKeysEnc: text("pgp_previous_keys_enc").array().notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    /**
     * Messages that arrived before this instant and carry no stored status
     * count as `handled`, so turning status tracking on does not flood the
     * client with years of old mail. A push fills existing rows with the time
     * of the push; new accounts start tracking when they are created.
     */
    statusTrackingSince: timestamp("status_tracking_since", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("mail_accounts_user_id_idx").on(t.userId)],
);

/**
 * Outgoing messages queued by an MCP client and waiting for the account
 * owner's decision. The full MIME input (including base64 attachments) lives
 * in `payload` so the message can be sent verbatim after approval.
 */
export const pendingMessages = pgTable(
  "pending_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PendingMessageKind>().notNull(),
    status: text("status").$type<PendingMessageStatus>().notNull().default("pending"),
    subject: text("subject").notNull(),
    toAddresses: text("to_addresses").array().notNull(),
    ccAddresses: text("cc_addresses").array().notNull().default([]),
    bccAddresses: text("bcc_addresses").array().notNull().default([]),
    payload: jsonb("payload").$type<PendingMessagePayload>().notNull(),
    /** Source message of a reply — kept for the reviewer's context only. */
    replyFolder: text("reply_folder"),
    replyUid: integer("reply_uid"),
    /** OAuth client that requested the send, when known. */
    requestedByClientId: text("requested_by_client_id"),
    decisionNote: text("decision_note"),
    sendResult: jsonb("send_result"),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("pending_messages_user_status_idx").on(t.userId, t.status),
    index("pending_messages_account_id_idx").on(t.accountId),
    index("pending_messages_created_at_idx").on(t.createdAt),
  ],
);

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  redirectUris: text("redirect_uris").array().notNull(),
  name: text("name"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const oauthAuthCodes = pgTable(
  "oauth_auth_codes",
  {
    code: text("code").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("oauth_auth_codes_expires_at_idx").on(t.expiresAt)],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accessTokenHash: text("access_token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash"),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("oauth_tokens_access_token_hash_idx").on(t.accessTokenHash),
    index("oauth_tokens_refresh_token_hash_idx").on(t.refreshTokenHash),
    index("oauth_tokens_user_id_idx").on(t.userId),
  ],
);

export const calendarAccounts = pgTable(
  "calendar_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    caldavUrl: text("caldav_url").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    defaultCalendarUrl: text("default_calendar_url"),
    color: text("color"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("calendar_accounts_user_id_idx").on(t.userId)],
);

/**
 * Address book: the people the user writes to regularly. Readable and
 * editable both from the web UI and over MCP, so a client can resolve "mail
 * Anna" to an address and keep the entry up to date. Addresses are stored
 * trimmed and lower-cased (see src/lib/contacts.ts), which is what makes the
 * per-user duplicate check a plain array overlap.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    emails: text("emails").array().notNull().default([]),
    phones: text("phones").array().notNull().default([]),
    organization: text("organization"),
    jobTitle: text("job_title"),
    /** How to greet this person in a mail, e.g. "Hallo Anna" or "Sehr geehrter Herr Weber". */
    salutation: text("salutation"),
    notes: text("notes"),
    tags: text("tags").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("contacts_user_id_idx").on(t.userId)],
);

/**
 * Processing status of received messages (see src/lib/message-status.ts).
 * Keyed by Message-ID rather than folder/UID so the status survives moving the
 * message to another folder; folder, uid and the header fields are a snapshot
 * from the last time the status was set, for the dashboard. A message without
 * a row is `new` (or `handled` when it predates `statusTrackingSince`).
 */
export const messageStatuses = pgTable(
  "message_statuses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** Message-ID header with angle brackets, or `uid:<folder>:<uid>` when the message has none. */
    messageKey: text("message_key").notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    /** Required while status = 'hold', null otherwise. */
    holdUntil: date("hold_until", { mode: "string" }),
    note: text("note"),
    folder: text("folder").notNull(),
    uid: integer("uid").notNull(),
    subject: text("subject"),
    fromAddress: text("from_address"),
    messageDate: timestamp("message_date", { withTimezone: true }),
    /** OAuth client that last set the status; null when set from the web UI. */
    updatedByClientId: text("updated_by_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("message_statuses_account_key_idx").on(t.accountId, t.messageKey),
    index("message_statuses_user_status_idx").on(t.userId, t.status),
  ],
);

/**
 * The user's OpenPGP keyring: one public key per correspondent address, used
 * to encrypt mail to them and to verify their signatures. Addresses are stored
 * lower-cased. Keys come from the web UI, from Web Key Directory lookups, or
 * are learned from received mail (Autocrypt header or attached key) — learning
 * never replaces a key that is already there.
 */
export const pgpKeys = pgTable(
  "pgp_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    fingerprint: text("fingerprint").notNull(),
    publicKey: text("public_key").notNull(),
    source: text("source").$type<PgpKeySource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("pgp_keys_user_email_idx").on(t.userId, t.email)],
);

export type PgpKeySource = "manual" | "wkd" | "autocrypt" | "attachment" | "mcp";

export type User = typeof users.$inferSelect;
export type PendingMessage = typeof pendingMessages.$inferSelect;
export type NewPendingMessage = typeof pendingMessages.$inferInsert;
export type MailAccount = typeof mailAccounts.$inferSelect;
export type NewMailAccount = typeof mailAccounts.$inferInsert;
export type CalendarAccount = typeof calendarAccounts.$inferSelect;
export type NewCalendarAccount = typeof calendarAccounts.$inferInsert;
export type MessageStatusRow = typeof messageStatuses.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type PgpKeyRow = typeof pgpKeys.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthAuthCode = typeof oauthAuthCodes.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
