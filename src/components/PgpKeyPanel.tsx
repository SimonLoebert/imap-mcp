"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PgpKeyInfo } from "@/lib/pgp";

/** Show, download, regenerate or import the account's OpenPGP key. */
export function PgpKeyPanel({
  accountId,
  pgpKey,
}: {
  accountId: string;
  pgpKey: PgpKeyInfo | null;
}) {
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [armoredKey, setArmoredKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replaceKey(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/pgp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
        throw new Error(msg || `HTTP ${res.status}`);
      }
      setImporting(false);
      setArmoredKey("");
      setPassphrase("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function generate() {
    if (
      pgpKey &&
      !confirm(
        "Replace the current key with a new one? Recipients who saved the old public key will see a different key on your next signed mail. The old key is kept to decrypt mail already sent to it.",
      )
    ) {
      return;
    }
    void replaceKey({ action: "generate" });
  }

  return (
    <div className="stack stack-sm" style={{ marginTop: 16 }}>
      {error && <div className="alert alert-error">{error}</div>}
      {pgpKey ? (
        <div style={{ fontSize: 14 }}>
          <div>
            <strong>Fingerprint:</strong> <code>{formatFingerprint(pgpKey.fingerprint)}</code>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {pgpKey.userIds.join(", ")} · {pgpKey.algorithm} · created{" "}
            {new Date(pgpKey.createdAt).toLocaleDateString()}
            {pgpKey.expiresAt && ` · expires ${new Date(pgpKey.expiresAt).toLocaleDateString()}`}
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          No key yet — one is generated automatically on the first signed send, or create or
          import one now.
        </p>
      )}
      <div className="row">
        {pgpKey && (
          <a className="btn btn-sm" href={`/api/accounts/${accountId}/pgp?download=1`}>
            Download public key
          </a>
        )}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={generate}>
          {pgpKey ? "Generate new key" : "Generate key"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setImporting((v) => !v)}
        >
          {importing ? "Cancel import" : "Import my own key"}
        </button>
      </div>
      {importing && (
        <div className="stack stack-sm">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>
              Armored private key{" "}
              <span className="hint">(-----BEGIN PGP PRIVATE KEY BLOCK-----)</span>
            </label>
            <textarea
              className="textarea"
              rows={6}
              value={armoredKey}
              onChange={(e) => setArmoredKey(e.target.value)}
              spellCheck={false}
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>
              Passphrase <span className="hint">(only if the key is protected)</span>
            </label>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            The key is unlocked once and stored encrypted with the server&apos;s master key; the
            passphrase itself is not kept. Anyone who controls this server can sign as you.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !armoredKey.trim()}
              onClick={() =>
                void replaceKey({
                  action: "import",
                  armoredKey,
                  passphrase: passphrase || undefined,
                })
              }
            >
              {busy ? "Importing…" : "Import key"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatFingerprint(fp: string): string {
  return fp.replace(/(.{4})/g, "$1 ").trim();
}
