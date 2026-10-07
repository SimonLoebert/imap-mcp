import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { countPending } from "@/lib/outbox";

/**
 * Shared header for the signed-in area. The outbox link carries the number of
 * messages waiting for approval so a queued draft is never missed.
 */
export async function TopNav() {
  let pending = 0;
  try {
    pending = await countPending(await getCurrentUserRowId());
  } catch {
    // Signed out or DB unavailable — the nav still renders, just without a count.
    pending = 0;
  }

  return (
    <nav className="topnav">
      <Link href="/" className="topnav-brand">
        <span className="topnav-logo">@</span>
        <span>IMAP MCP</span>
      </Link>
      <div className="topnav-links">
        <Link href="/accounts" className="btn btn-ghost btn-sm">
          My emails
        </Link>
        <Link href="/calendars" className="btn btn-ghost btn-sm">
          My calendars
        </Link>
        <Link href="/contacts" className="btn btn-ghost btn-sm">
          Contacts
        </Link>
        <Link href="/outbox" className="btn btn-ghost btn-sm">
          Approvals
          {pending > 0 && (
            <span className="badge" style={{ marginLeft: 6 }}>
              {pending}
            </span>
          )}
        </Link>
        <Link href="/connect" className="btn btn-ghost btn-sm">
          Connect to Claude
        </Link>
        <UserButton />
      </div>
    </nav>
  );
}
