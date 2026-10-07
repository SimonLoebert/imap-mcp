import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { listKeyring } from "@/lib/pgp-keyring";
import { PgpKeyring } from "@/components/PgpKeyring";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const userId = await getCurrentUserRowId();
  const keys = await listKeyring(userId);
  return (
    <div className="stack stack-lg">
      <div>
        <h2 style={{ marginBottom: 4 }}>PGP keys</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          Public keys of the people you write to. Mail to an address listed here can be sent
          encrypted, and their signed mail is verified against it. Keys arrive from you, from
          the recipient&apos;s Web Key Directory, or are learned from their mail the first
          time they send one — a learned key never replaces one you already have.
        </p>
      </div>
      <PgpKeyring keys={keys} />
    </div>
  );
}
