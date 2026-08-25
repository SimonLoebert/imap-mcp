import Link from "next/link";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { approvalTtlHours, listPending } from "@/lib/outbox";
import { OutboxList } from "@/components/OutboxList";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const userId = await getCurrentUserRowId();
  const messages = await listPending(userId, { limit: 100 });
  const pendingCount = messages.filter((m) => m.status === "pending").length;

  return (
    <div className="stack stack-lg">
      <div className="header">
        <div>
          <h2 style={{ marginBottom: 4 }}>Approvals</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            Emails Claude wants to send on your behalf land here first. Nothing reaches
            SMTP until you approve it.
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="badge">
            {pendingCount} waiting
          </span>
        )}
      </div>

      {messages.length === 0 && (
        <div className="alert alert-info">
          Approval is enabled per account — check the{" "}
          <Link href="/accounts">account settings</Link> to turn it on or off. Pending
          messages expire after {approvalTtlHours()} hours without a decision.
        </div>
      )}

      <OutboxList messages={messages} />
    </div>
  );
}
