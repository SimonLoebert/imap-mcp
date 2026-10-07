"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { KeyringEntry, ImportResult } from "@/lib/pgp-keyring";

const SOURCE_LABEL: Record<KeyringEntry["source"], string> = {
  manual: "added by you",
  wkd: "Web Key Directory",
  autocrypt: "learned (Autocrypt)",
  attachment: "learned (attached key)",
  mcp: "added by Claude",
};

/** Import, look up and delete correspondents' public keys. */
export function PgpKeyring({ keys }: { keys: KeyringEntry[] }) {
  const router = useRouter();
  const [armoredKey, setArmoredKey] = useState("");
  const [lookupEmail, setLookupEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ImportResult[]>([]);

  async function call(url: string, init: RequestInit) {
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
    }
    return body;
  }

  async function importKey(replace: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { results } = (await call("/api/pgp-keys", {
        method: "POST",
        body: JSON.stringify({ armoredKey, replace }),
      })) as { results: ImportResult[] };
      const conflicting = results.filter((r) => r.status === "conflict");
      setConflicts(conflicting);
      setNotice(results.map((r) => `${r.email}: ${r.status}`).join(" · "));
      if (!conflicting.length) setArmoredKey("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lookup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await call("/api/pgp-keys/lookup", {
        method: "POST",
        body: JSON.stringify({ email: lookupEmail }),
      });
      setNotice(
        r.found
          ? `${r.email}: key ${formatFingerprint(r.fingerprint)} (${r.source})`
          : `${r.email}: no key found in your keyring or the domain's Web Key Directory`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: KeyringEntry) {
    if (!confirm(`Delete the key for ${entry.email}? Mail to them can no longer be encrypted.`)) {
      return;
    }
    try {
      await call(`/api/pgp-keys/${entry.id}`, { method: "DELETE" });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack stack-lg">
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Add a key</h3>
        <div className="field">
          <label>
            Public key <span className="hint">(-----BEGIN PGP PUBLIC KEY BLOCK-----)</span>
          </label>
          <textarea
            className="textarea"
            rows={5}
            value={armoredKey}
            onChange={(e) => setArmoredKey(e.target.value)}
            spellCheck={false}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </div>
        {conflicts.length > 0 && (
          <div className="alert alert-warning">
            {conflicts.map((c) => (
              <div key={c.email}>
                {c.email} already has key {formatFingerprint(c.existingFingerprint ?? "")}; this
                one is {formatFingerprint(c.fingerprint)}.
              </div>
            ))}
            Only replace it if you checked the new fingerprint with the person.
          </div>
        )}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !armoredKey.trim()}
            onClick={() => void importKey(false)}
          >
            Import
          </button>
          {conflicts.length > 0 && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void importKey(true)}
            >
              Replace existing key
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <input
            className="input"
            type="email"
            placeholder="name@example.com"
            value={lookupEmail}
            onChange={(e) => setLookupEmail(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !lookupEmail.includes("@")}
            onClick={() => void lookup()}
          >
            Look up (WKD)
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Keyring ({keys.length})</h3>
        {keys.length === 0 ? (
          <p className="muted">No keys yet.</p>
        ) : (
          <div className="stack stack-sm">
            {keys.map((k) => (
              <div key={k.id} className="row-between" style={{ gap: 12 }}>
                <div style={{ fontSize: 14, minWidth: 0 }}>
                  <div>
                    <strong>{k.email}</strong>{" "}
                    <span className="badge badge-soft">{SOURCE_LABEL[k.source]}</span>{" "}
                    {!k.canEncrypt && <span className="badge badge-danger">cannot encrypt</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                    <code>{formatFingerprint(k.fingerprint)}</code>
                    {k.expiresAt && ` · expires ${new Date(k.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(k)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatFingerprint(fp: string): string {
  return fp.replace(/(.{4})/g, "$1 ").trim();
}
