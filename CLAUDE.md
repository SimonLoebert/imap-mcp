# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A self-hosted **remote MCP server** that exposes a user's IMAP/SMTP mail accounts and
CalDAV calendars to MCP clients, plus the web UI to manage those accounts. One Next.js 15
app (App Router, React 19, TypeScript strict), one Postgres, one container. Keep it that
way — the project deliberately favours boring dependencies over a service split.

## Commands

```bash
npm run dev          # next dev
npm run build        # next build — must pass before any PR
npm run typecheck    # tsc --noEmit — must pass before any PR
npm run db:push      # apply src/lib/db/schema.ts to DATABASE_URL (no migration files in repo)
npm run db:studio    # drizzle studio
```

There is **no test runner and no ESLint config** in this repo. `npm run lint` drops into
Next's interactive setup prompt — don't call it. To verify behaviour, run a throwaway
Postgres (`initdb` as the `postgres` user, `drizzle-kit push`) and drive the code with a
`tsx` script; delete the script afterwards.

Copy `.env.example` to `.env` — `DATABASE_URL`, `MCP_MASTER_KEY` (32 random bytes, base64)
and the Clerk keys are required for anything to boot.

## Layout

```
src/app/api/mcp/route.ts     Bearer-auth + Streamable HTTP transport → buildMcpServer()
src/lib/mcp/server.ts        Every MCP tool. One registerTool() call per tool.
src/lib/mcp/context.ts       Per-request context ({userId, clientId}) + account loaders
src/lib/imap.ts              All IMAP work (imapflow), folder/message/attachment helpers
src/lib/smtp.ts              All SMTP work (nodemailer) + signature handling
src/lib/caldav.ts            All CalDAV work (tsdav) + ical.js parsing
src/lib/outbox.ts            Human-in-the-loop approval queue (state machine)
src/lib/outbox-types.ts      Types shared by schema, server, API and client components
src/lib/db/schema.ts         Single source of truth for the DB — no migration files
src/lib/crypto.ts            AES-256-GCM for stored credentials
src/lib/auth/oauth.ts        OAuth 2.1 + PKCE + DCR for MCP clients
src/lib/auth/clerk.ts        Human auth; getCurrentUserRowId() maps Clerk → users.id
src/app/outbox/              Approval UI
src/components/              Client components ("use client") + the shared TopNav
```

## Rules that keep this codebase safe

**Two auth realms, never mixed.** MCP clients authenticate with an OAuth bearer token
(`resolveAccessToken`), humans authenticate with Clerk (`getCurrentUserRowId`). An MCP
token must never reach a `/api/accounts`, `/api/calendar-accounts` or `/api/outbox` route,
and Clerk auth must never reach `/api/mcp`. New protected routes go into the
`isProtectedRoute` matcher in `src/middleware.ts`.

**Every query is scoped to the user.** Load accounts through `requireAccount` /
`requireCalendarAccount`, and always put `eq(table.userId, userId)` in the `where` of any
direct query. A missing tenant filter is a cross-account data leak, not a style issue.

**Outgoing mail goes through the approval gate.** `dispatchOrQueue` in
`src/lib/mcp/server.ts` is the only place an MCP tool may hand a message to `sendMail`.
When `mailAccounts.requireSendApproval` is set (the default), the message is parked in
`pending_messages` and returns `status: "pending_approval"` instead. Rules:

- A tool may *add* a review step (`request_approval: true`) but must never be able to skip
  the account's own requirement.
- Approving is a **human-only** action — it lives behind Clerk in `/api/outbox/[id]`.
  Never expose an approve tool over MCP.
- The `pending → sending` transition is a guarded `UPDATE … WHERE status = 'pending'` in
  `approveAndSend`. Keep it guarded; it is what prevents a double click from sending
  twice.
- Any new send path (a scheduled send, a forward tool, …) must route through
  `dispatchOrQueue` too.

**Sanitize any HTML that round-trips through the server.** Signatures go through
`sanitizeSignatureHtml`, queued message bodies through `sanitizeBodyHtml` in
`src/lib/outbox.ts`, before storage and before display.

**Credentials never leave the server.** Passwords are stored encrypted and REST responses
strip `*PasswordEnc`. Don't add them to a select list or a log line.

**Schema changes are `db:push`, not migrations.** Edit `src/lib/db/schema.ts` and note the
change in the README's *Data model* block. New columns on existing tables need a sensible
`.default()` so a push against a populated database succeeds.

## MCP tool conventions

- `snake_case` tool names and argument names; `camelCase` everywhere in TypeScript.
- Wrap every handler body in `try/catch` and return `errorResult(e)` — a thrown error
  breaks the transport.
- Return `jsonResult(...)` with a plain object; keep payloads small (link to attachments
  with signed URLs rather than embedding blobs by default).
- Write the `description` for the model, not for a human reader: state what the tool does
  *and* what the caller must not assume. The description is the only contract the client
  gets — if a tool can silently not do the thing its name suggests (like `send_message`
  under an approval gate), say so there in as many words.
- Account IDs are UUIDs validated with `z.string().uuid()`; folders are paths, messages are
  UIDs within a folder.

## UI conventions

Plain CSS in `src/app/globals.css` with CSS variables and a `prefers-color-scheme` dark
block — no Tailwind, no CSS-in-JS. Reuse the existing classes (`card`, `btn`, `badge`,
`alert`, `field`, `stack`, `row`, `tabs`) instead of inventing new ones; add a class to
`globals.css` only when nothing fits. Pages are server components with
`export const dynamic = "force-dynamic"`; interactivity lives in a `"use client"`
component under `src/components/`, and mutations call the REST API and then
`router.refresh()`.
