"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ActionableResult,
  ActionableTracked,
  MessageStatus,
  NewMessageView,
  TrackedMessageView,
} from "@/lib/message-status-types";

/** One row of the dashboard, whether it has a stored status or not. */
interface Item {
  key: string;
  /** Stored status row; null for a new message nobody has touched. */
  rowId: string | null;
  accountId: string;
  folder: string;
  uid: number;
  subject: string | null;
  from: string | null;
  date: string | null;
  status: MessageStatus;
  holdUntil: string | null;
  holdDue: boolean;
  note: string | null;
  threadHold: NewMessageView["threadHold"];
  newReplies: ActionableTracked["newReplies"];
}

const STATUS_LABEL: Record<MessageStatus, string> = {
  new: "New",
  unhandled: "Unhandled",
  handled: "Handled",
  hold: "On hold",
};

function statusBadgeClass(item: Item): string {
  switch (item.status) {
    case "new":
      return "badge";
    case "unhandled":
      return "badge badge-danger";
    case "handled":
      return "badge badge-success";
    case "hold":
      return item.holdDue ? "badge badge-danger" : "badge badge-soft";
  }
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString();
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fromNew(m: NewMessageView): Item {
  return {
    key: `${m.accountId}:${m.messageId}`,
    rowId: null,
    accountId: m.accountId,
    folder: m.folder,
    uid: m.uid,
    subject: m.subject,
    from: m.from,
    date: m.date,
    status: "new",
    holdUntil: null,
    holdDue: false,
    note: null,
    threadHold: m.threadHold,
    newReplies: [],
  };
}

function fromTracked(t: TrackedMessageView & { newReplies?: ActionableTracked["newReplies"] }): Item {
  return {
    key: `${t.accountId}:${t.messageId}`,
    rowId: t.id,
    accountId: t.accountId,
    folder: t.folder,
    uid: t.uid,
    subject: t.subject,
    from: t.fromAddress,
    date: t.messageDate,
    status: t.status,
    holdUntil: t.holdUntil,
    holdDue: t.holdDue,
    note: t.note,
    threadHold: null,
    newReplies: t.newReplies ?? [],
  };
}

export function StatusDashboard({
  results,
  recentlyHandled,
  accountLabels,
  today,
}: {
  results: ActionableResult[];
  recentlyHandled: TrackedMessageView[];
  accountLabels: Record<string, string>;
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [holdDate, setHoldDate] = useState(addDays(today, 7));
  const [holdNote, setHoldNote] = useState("");

  const newItems = results.flatMap((r) => r.new.map(fromNew));
  const newTotal = results.reduce((n, r) => n + r.newTotal, 0);
  const unhandled = results.flatMap((r) => r.unhandled.map(fromTracked));
  const holdDue = results.flatMap((r) => r.holdDue.map(fromTracked));
  const holdUpcoming = results.flatMap((r) => r.holdUpcoming.map(fromTracked));
  const handled = recentlyHandled.map(fromTracked);
  const failedFolders = results.flatMap((r) =>
    r.failedFolders.map((f) => `${accountLabels[r.account.id] ?? r.account.email}: ${f}`),
  );

  async function setStatus(
    item: Item,
    status: MessageStatus,
    extra: { holdUntil?: string; note?: string | null } = {},
  ) {
    setBusy(item.key);
    setError(null);
    try {
      const res = item.rowId
        ? await fetch(`/api/message-status/${item.rowId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status, ...extra }),
          })
        : await fetch("/api/message-status", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: item.accountId,
              folder: item.folder,
              uid: item.uid,
              status,
              ...extra,
            }),
          });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      setHoldFor(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearStatus(item: Item) {
    if (!item.rowId) return;
    setBusy(item.key);
    setError(null);
    try {
      const res = await fetch(`/api/message-status/${item.rowId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function openHold(item: Item) {
    setHoldFor(item.key);
    setHoldDate(item.holdUntil && item.holdUntil >= today ? item.holdUntil : addDays(today, 7));
    setHoldNote(item.note ?? "");
  }

  function renderItem(item: Item) {
    const running = busy === item.key;
    return (
      <div key={item.key} className="card">
        <div className="row row-between" style={{ gap: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 8 }}>
              <strong>{item.subject || "(no subject)"}</strong>
              <span className={statusBadgeClass(item)}>
                {item.status === "hold" && item.holdUntil
                  ? `${item.holdDue ? "Due" : "On hold until"} ${formatDay(item.holdUntil)}`
                  : STATUS_LABEL[item.status]}
              </span>
              {item.threadHold && <span className="badge badge-soft">answers a held message</span>}
              {item.newReplies.length > 0 && (
                <span className="badge badge-success">
                  {item.newReplies.length === 1 ? "reply arrived" : `${item.newReplies.length} replies arrived`}
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {[item.from, formatDate(item.date), `${accountLabels[item.accountId] ?? ""} · ${item.folder}`]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {item.note && <p style={{ fontSize: 14, marginTop: 6 }}>{item.note}</p>}
            {item.threadHold && (
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                Reply to “{item.threadHold.subject || "(no subject)"}”, on hold until{" "}
                {formatDay(item.threadHold.holdUntil)}
                {item.threadHold.note ? ` — ${item.threadHold.note}` : ""}
              </p>
            )}
            {item.newReplies.map((r) => (
              <p key={r.messageId} className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                Reply from {r.from ?? "unknown sender"}: “{r.subject || "(no subject)"}” in {r.folder}
              </p>
            ))}
          </div>
        </div>

        {holdFor === item.key ? (
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <input
              type="date"
              className="input"
              style={{ width: "auto" }}
              min={today}
              value={holdDate}
              onChange={(e) => setHoldDate(e.target.value)}
            />
            <input
              className="input"
              style={{ flex: 1, minWidth: 180 }}
              placeholder="Note (optional), e.g. waiting for the quote"
              value={holdNote}
              onChange={(e) => setHoldNote(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={running || !holdDate}
              onClick={() => setStatus(item, "hold", { holdUntil: holdDate, note: holdNote.trim() || null })}
            >
              {running ? <span className="spinner" /> : "Put on hold"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHoldFor(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            {item.status === "new" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={running}
                onClick={() => setStatus(item, "unhandled")}
              >
                Seen, reply pending
              </button>
            )}
            {item.status === "hold" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={running}
                onClick={() => setStatus(item, "unhandled")}
              >
                Back to unhandled
              </button>
            )}
            {item.status !== "handled" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={running}
                onClick={() => setStatus(item, "handled")}
              >
                Handled
              </button>
            )}
            {item.status !== "handled" && (
              <button type="button" className="btn btn-sm" disabled={running} onClick={() => openHold(item)}>
                {item.status === "hold" ? "Change date…" : "Hold…"}
              </button>
            )}
            {item.status === "handled" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={running}
                onClick={() => setStatus(item, "unhandled")}
              >
                Reopen
              </button>
            )}
            {item.rowId && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={running}
                title="Forget the stored status; the message falls back to new (or handled if it predates tracking)"
                onClick={() => clearStatus(item)}
              >
                Clear status
              </button>
            )}
            {running && <span className="spinner" />}
          </div>
        )}
      </div>
    );
  }

  function section(title: string, hint: string, items: Item[], empty: string, extra?: string) {
    return (
      <section className="stack">
        <div>
          <h3 style={{ marginBottom: 2 }}>
            {title} <span className="muted">({items.length})</span>
          </h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {hint}
            {extra ? ` ${extra}` : ""}
          </p>
        </div>
        {items.length === 0 ? (
          <p className="muted" style={{ fontSize: 14 }}>
            {empty}
          </p>
        ) : (
          items.map(renderItem)
        )}
      </section>
    );
  }

  return (
    <div className="stack stack-lg">
      <div className="grid-4">
        <div className="card">
          <div className="stat-value">{newTotal}</div>
          <div className="muted">New</div>
        </div>
        <div className="card">
          <div className="stat-value">{unhandled.length}</div>
          <div className="muted">Unhandled</div>
        </div>
        <div className="card">
          <div className="stat-value">{holdDue.length}</div>
          <div className="muted">Hold due</div>
        </div>
        <div className="card">
          <div className="stat-value">{holdUpcoming.length}</div>
          <div className="muted">On hold</div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {failedFolders.length > 0 && (
        <div className="alert alert-warning">
          Some folders could not be scanned: {failedFolders.join(", ")}
        </div>
      )}

      {section(
        "Hold due",
        "The date has come: answer now, or check whether the reply you were waiting for arrived.",
        holdDue,
        "No hold is due.",
      )}
      {section(
        "New",
        "Arrived since tracking started and nobody has told you about them yet.",
        newItems,
        "Nothing new.",
        newTotal > newItems.length ? `Showing ${newItems.length} of ${newTotal}.` : undefined,
      )}
      {section("Unhandled", "You know about these; a reply is still owed.", unhandled, "Nothing waiting for a reply.")}
      {section("On hold", "Parked until a later date.", holdUpcoming, "Nothing on hold.")}
      {section("Recently handled", "The last 20 messages marked handled.", handled, "Nothing handled yet.")}
    </div>
  );
}
