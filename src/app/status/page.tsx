import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { listUserAccounts, requireAccount } from "@/lib/mcp/context";
import { listActionable, listRecentlyHandled, today } from "@/lib/message-status";
import type { ActionableResult } from "@/lib/message-status-types";
import { StatusDashboard } from "@/components/StatusDashboard";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const userId = await getCurrentUserRowId();
  const accounts = await listUserAccounts(userId);

  // Each account scans its own IMAP server; one failing must not blank the page.
  const settled = await Promise.all(
    accounts.map(async (a) => {
      try {
        const acc = await requireAccount(userId, a.id);
        return { ok: true as const, result: await listActionable(acc, { includeUpcomingHolds: true }) };
      } catch (e) {
        return {
          ok: false as const,
          label: a.label,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  const results: ActionableResult[] = [];
  const errors: Array<{ label: string; error: string }> = [];
  for (const s of settled) {
    if (s.ok) results.push(s.result);
    else errors.push({ label: s.label, error: s.error });
  }
  const recentlyHandled = await listRecentlyHandled(userId, 20);

  return (
    <div className="stack stack-lg">
      <div className="header">
        <div>
          <h2 style={{ marginBottom: 4 }}>Inbox status</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            Where Claude stands with your incoming mail: what is new, what still needs a
            reply and what is parked until a date.
          </p>
        </div>
      </div>

      {accounts.length === 0 && (
        <div className="alert alert-info">Add an email account to start tracking messages.</div>
      )}

      {errors.map((e) => (
        <div key={e.label} className="alert alert-error">
          {e.label}: could not read the mailbox — {e.error}
        </div>
      ))}

      <StatusDashboard
        results={results}
        recentlyHandled={recentlyHandled}
        accountLabels={Object.fromEntries(accounts.map((a) => [a.id, a.label]))}
        today={today()}
      />
    </div>
  );
}
