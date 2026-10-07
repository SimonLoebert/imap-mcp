"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PendingMessageStatus, PendingMessageSummary } from "@/lib/outbox-types";

type Busy = { id: string; action: string } | null;

const STATUS_LABEL: Record<PendingMessageStatus, string> = {
  pending: "Awaiting your approval",
  sending: "Sending…",
  sent: "Sent",
  failed: "Send failed",
  rejected: "Rejected by you",
  cancelled: "Withdrawn by the client",
  expired: "Expired without a decision",
};

function statusBadgeClass(status: PendingMessageStatus): string {
  switch (status) {
    case "sent":
      return "badge badge-success";
    case "failed":
    case "rejected":
      return "badge badge-danger";
    case "pending":
      return "badge";
    default:
      return "badge badge-muted";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function totalAttachmentBytes(message: PendingMessageSummary): number {
  return message.attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
}

function relativeDeadline(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3600000);
  if (hours >= 24) return `expires in ${Math.floor(hours / 24)} d`;
  if (hours >= 1) return `expires in ${hours} h`;
  return `expires in ${Math.max(1, Math.round(ms / 60000))} min`;
}

function MessageBody({ message }: { message: PendingMessageSummary }) {
  const [showHtml, setShowHtml] = useState(Boolean(message.bodyHtml));
  const hasBoth = Boolean(message.bodyHtml) && Boolean(message.bodyText);

  return (
    <div className="stack stack-sm">
      {hasBoth && (
        <div className="tabs">
          <button
            type="button"
            className={showHtml ? "tab active" : "tab"}
            onClick={() => setShowHtml(true)}
          >
            HTML
          </button>
          <button
            type="button"
            className={!showHtml ? "tab active" : "tab"}
            onClick={() => setShowHtml(false)}
          >
            Plain text
          </button>
        </div>
      )}
      {showHtml && message.bodyHtml ? (
        <div
          className="outbox-body"
          // Sanitized server-side with DOMPurify before it ever reaches the client.
          dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
        />
      ) : (
        <pre className="outbox-body outbox-body-text">{message.bodyText ?? "(empty body)"}</pre>
      )}
      {message.includeSignature && (
        <p className="muted" style={{ fontSize: 13 }}>
          The account signature is appended on send and is not part of this preview.
        </p>
      )}
      {(message.pgpSign || message.attachPublicKey) && (
        <p className="muted" style={{ fontSize: 13 }}>
          {message.pgpSign && message.attachPublicKey
            ? "Signed with the account's PGP key; the public key is attached."
            : message.pgpSign
              ? "Signed with the account's PGP key."
              : "The account's PGP public key is attached (message not signed)."}
        </p>
      )}
    </div>
  );
}

function Recipients({ message }: { message: PendingMessageSummary }) {
  return (
    <div className="stack stack-sm" style={{ fontSize: 14 }}>
      <div>
        <span className="muted">To </span>
        {message.to.join(", ")}
      </div>
      {message.cc.length > 0 && (
        <div>
          <span className="muted">Cc </span>
          {message.cc.join(", ")}
        </div>
      )}
      {message.bcc.length > 0 && (
        <div>
          <span className="muted">Bcc </span>
          {message.bcc.join(", ")}
        </div>
      )}
    </div>
  );
}

export function OutboxList({ messages }: { messages: PendingMessageSummary[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { pending, history } = useMemo(() => {
    const p = messages.filter((m) => m.status === "pending" || m.status === "sending");
    const h = messages.filter((m) => m.status !== "pending" && m.status !== "sending");
    return { pending: p, history: h };
  }, [messages]);

  async function act(id: string, action: "approve" | "reject" | "retry") {
    setBusy({ id, action });
    setError(null);
    try {
      const res = await fetch(`/api/outbox/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note: notes[id]?.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        );
      }
      if (action === "approve" && body.message?.status === "failed") {
        setError(`SMTP refused the message: ${body.message.errorMessage ?? "unknown error"}`);
      }
      setNotes((s) => ({ ...s, [id]: "" }));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this entry from the history?")) return;
    setBusy({ id, action: "delete" });
    setError(null);
    try {
      const res = await fetch(`/api/outbox/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        );
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Upload files the reviewer picked onto a message that is still pending. */
  async function attach(id: string, files: File[]) {
    if (files.length === 0) return;
    setBusy({ id, action: "attach" });
    setError(null);
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const res = await fetch(`/api/outbox/${id}/attachments`, {
        method: "POST",
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        );
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function detach(id: string, index: number, filename: string) {
    if (!confirm(`Remove "${filename}" from this message?`)) return;
    setBusy({ id, action: "detach" });
    setError(null);
    try {
      const res = await fetch(`/api/outbox/${id}/attachments?index=${index}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        );
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function Card({ message }: { message: PendingMessageSummary }) {
    const isPending = message.status === "pending";
    const running = busy?.id === message.id;

    return (
      <div className="card outbox-card" id={`msg-${message.id}`}>
        <div className="row row-between" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong>{message.subject || "(no subject)"}</strong>
              <span className={statusBadgeClass(message.status)}>
                {STATUS_LABEL[message.status]}
              </span>
              {message.kind === "reply" && <span className="badge badge-soft">reply</span>}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              From {message.accountLabel} &lt;{message.accountEmail}&gt; · queued{" "}
              {formatDate(message.createdAt)}
              {isPending && ` · ${relativeDeadline(message.expiresAt)}`}
            </div>
          </div>
        </div>

        <div className="divider" />
        <Recipients message={message} />
        <div className="divider" />
        <MessageBody message={message} />

        {(message.attachments.length > 0 || isPending) && (
          <div className="stack stack-sm" style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              {message.attachments.length === 0
                ? "No attachments"
                : `${message.attachments.length} attachment${
                    message.attachments.length === 1 ? "" : "s"
                  } · ${formatBytes(totalAttachmentBytes(message))}`}
            </div>
            {message.attachments.length > 0 && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {message.attachments.map((a) => (
                  <span key={a.index} className="attachment-chip">
                    <span className="attachment-name" title={a.filename}>
                      📎 {a.filename}
                    </span>
                    <span className="muted">{formatBytes(a.sizeBytes)}</span>
                    {a.addedBy === "user" && (
                      <span className="badge badge-soft">added by you</span>
                    )}
                    {isPending && a.removable && (
                      <button
                        type="button"
                        className="attachment-remove"
                        disabled={running}
                        aria-label={`Remove ${a.filename}`}
                        title={`Remove ${a.filename}`}
                        onClick={() => detach(message.id, a.index, a.filename)}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {isPending && (
              <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label className={running ? "btn btn-sm btn-file is-disabled" : "btn btn-sm btn-file"}>
                  {running && busy?.action === "attach" ? "Uploading…" : "＋ Add files"}
                  <input
                    type="file"
                    multiple
                    className="visually-hidden"
                    disabled={running}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      // Reset so picking the same file twice fires onChange again.
                      e.target.value = "";
                      void attach(message.id, picked);
                    }}
                  />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  Files you add here are sent along with the message.
                </span>
              </div>
            )}
          </div>
        )}

        {message.replyTo && (
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Replies to UID {message.replyTo.uid} in {message.replyTo.folder}
          </p>
        )}
        {message.requestedByClientId && (
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Requested by MCP client {message.requestedByClientId}
          </p>
        )}
        {message.decisionNote && (
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Note: {message.decisionNote}
          </p>
        )}
        {message.sentAt && (
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Sent {formatDate(message.sentAt)}
          </p>
        )}
        {message.errorMessage && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>
            {message.errorMessage}
          </div>
        )}

        {isPending && (
          <div className="stack stack-sm" style={{ marginTop: 16 }}>
            <input
              className="input"
              placeholder="Optional note (kept in the history, visible to the MCP client)"
              value={notes[message.id] ?? ""}
              onChange={(e) =>
                setNotes((s) => ({ ...s, [message.id]: e.target.value }))
              }
            />
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={running}
                onClick={() => act(message.id, "approve")}
              >
                {running && busy?.action === "approve" ? "Sending…" : "Approve & send"}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={running}
                onClick={() => act(message.id, "reject")}
              >
                {running && busy?.action === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </div>
          </div>
        )}

        {message.status === "failed" && (
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => act(message.id, "retry")}
            >
              {running && busy?.action === "retry" ? "Re-queuing…" : "Queue again"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={running}
              onClick={() => remove(message.id)}
            >
              Delete
            </button>
          </div>
        )}

        {message.status !== "failed" && !isPending && message.status !== "sending" && (
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={running}
              onClick={() => remove(message.id)}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  const shown = tab === "pending" ? pending : history;

  return (
    <div className="stack stack-lg">
      {error && <div className="alert alert-error">{error}</div>}

      <div className="tabs">
        <button
          type="button"
          className={tab === "pending" ? "tab active" : "tab"}
          onClick={() => setTab("pending")}
        >
          Awaiting approval ({pending.length})
        </button>
        <button
          type="button"
          className={tab === "history" ? "tab active" : "tab"}
          onClick={() => setTab("history")}
        >
          History ({history.length})
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>{tab === "pending" ? "✅" : "🗂️"}</div>
          <h3 style={{ marginBottom: 6 }}>
            {tab === "pending" ? "Nothing waiting for you" : "No decisions yet"}
          </h3>
          <p className="muted">
            {tab === "pending"
              ? "Emails Claude wants to send show up here before they leave your server."
              : "Approved, rejected and expired messages are listed here."}
          </p>
        </div>
      ) : (
        <div className="stack">
          {shown.map((m) => (
            <Card key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}
