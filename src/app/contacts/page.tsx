import Link from "next/link";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { listContacts } from "@/lib/contacts";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const { q, tag } = await searchParams;
  const userId = await getCurrentUserRowId();
  const { contacts, hasMore } = await listContacts(userId, { query: q, tag, limit: 500 });
  const filtered = Boolean(q || tag);

  return (
    <div className="stack stack-lg">
      <div className="header">
        <div>
          <h2 style={{ marginBottom: 4 }}>Contacts</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            The people you write to regularly. Claude can look them up, add new ones and
            keep them up to date through MCP.
          </p>
        </div>
        <Link href="/contacts/new" className="btn btn-primary">
          + Add contact
        </Link>
      </div>

      <form className="row" style={{ gap: 8 }} method="get">
        <input
          className="input"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, email, organization, tag or notes"
          style={{ flex: 1 }}
        />
        {tag && <input type="hidden" name="tag" value={tag} />}
        <button type="submit" className="btn">
          Search
        </button>
        {filtered && (
          <Link href="/contacts" className="btn btn-ghost">
            Clear
          </Link>
        )}
      </form>

      {tag && (
        <div className="muted" style={{ fontSize: 14 }}>
          Tagged <span className="badge badge-soft">{tag}</span>
        </div>
      )}

      {contacts.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📇</div>
          <h3 style={{ marginBottom: 6 }}>
            {filtered ? "No contact matches" : "No contacts yet"}
          </h3>
          <p className="muted" style={{ marginBottom: 20 }}>
            {filtered
              ? "Try a different search term."
              : "Add the people you mail most often so Claude can address them correctly."}
          </p>
          <Link href="/contacts/new" className="btn btn-primary">
            + Add contact
          </Link>
        </div>
      ) : (
        <div className="stack">
          {contacts.map((c) => (
            <div key={c.id} className="card card-hover">
              <div className="row row-between" style={{ gap: 16 }}>
                <Link
                  href={`/contacts/${c.id}`}
                  style={{ color: "inherit", textDecoration: "none", flex: 1, minWidth: 0 }}
                >
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    {(c.jobTitle || c.organization) && (
                      <span className="muted" style={{ fontSize: 14 }}>
                        {[c.jobTitle, c.organization].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                    {[...c.emails, ...c.phones].join(" · ") || "No address or phone"}
                  </div>
                </Link>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {c.tags.map((t) => (
                    <Link
                      key={t}
                      href={`/contacts?tag=${encodeURIComponent(t)}`}
                      className="badge badge-soft"
                      style={{ textDecoration: "none" }}
                    >
                      {t}
                    </Link>
                  ))}
                  <Link href={`/contacts/${c.id}`} className="btn btn-sm">
                    Edit
                  </Link>
                </div>
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="alert alert-info">
              Showing the first {contacts.length} contacts — search to narrow the list.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
