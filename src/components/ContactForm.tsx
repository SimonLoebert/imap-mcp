"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ContactFormValues {
  name: string;
  /** One address per line. */
  emails: string;
  /** One number per line. */
  phones: string;
  organization: string;
  jobTitle: string;
  salutation: string;
  notes: string;
  /** Comma-separated. */
  tags: string;
}

const empty: ContactFormValues = {
  name: "",
  emails: "",
  phones: "",
  organization: "",
  jobTitle: "",
  salutation: "",
  notes: "",
  tags: "",
};

function splitList(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ContactForm({
  mode,
  contactId,
  initial,
}: {
  mode: "create" | "edit";
  contactId?: string;
  initial?: Partial<ContactFormValues>;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ContactFormValues>({ ...empty, ...initial });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof ContactFormValues>(key: K, v: ContactFormValues[K]) {
    setValues((s) => ({ ...s, [key]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const url = mode === "create" ? "/api/contacts" : `/api/contacts/${contactId}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload = {
        name: values.name,
        emails: splitList(values.emails, /[\n,;]/),
        phones: splitList(values.phones, /\n/),
        organization: values.organization || null,
        jobTitle: values.jobTitle || null,
        salutation: values.salutation || null,
        notes: values.notes || null,
        tags: splitList(values.tags, /,/),
      };
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          typeof body.error === "string"
            ? body.error
            : body.error
              ? JSON.stringify(body.error)
              : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      router.push("/contacts");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!contactId) return;
    if (!confirm("Delete this contact?")) return;
    const res = await fetch(`/api/contacts/${contactId}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/contacts");
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16 }}>Person</h3>
        <div className="field">
          <label>Name</label>
          <input
            className="input"
            value={values.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="Anna Schmidt"
            required
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>
              Organization <span className="hint">(optional)</span>
            </label>
            <input
              className="input"
              value={values.organization}
              onChange={(e) => update("organization", e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              Job title <span className="hint">(optional)</span>
            </label>
            <input
              className="input"
              value={values.jobTitle}
              onChange={(e) => update("jobTitle", e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16 }}>Reach</h3>
        <div className="grid-2">
          <div className="field">
            <label>
              Email addresses <span className="hint">(one per line, primary first)</span>
            </label>
            <textarea
              className="textarea"
              rows={3}
              value={values.emails}
              onChange={(e) => update("emails", e.target.value)}
              placeholder="anna@example.com"
            />
          </div>
          <div className="field">
            <label>
              Phone numbers <span className="hint">(one per line)</span>
            </label>
            <textarea
              className="textarea"
              rows={3}
              value={values.phones}
              onChange={(e) => update("phones", e.target.value)}
              placeholder="+49 30 1234567"
            />
          </div>
        </div>
        <div className="field">
          <label>
            Salutation <span className="hint">(how Claude should greet this person)</span>
          </label>
          <input
            className="input"
            value={values.salutation}
            onChange={(e) => update("salutation", e.target.value)}
            placeholder="Hallo Anna / Sehr geehrter Herr Weber"
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16 }}>Context</h3>
        <div className="field">
          <label>
            Tags <span className="hint">(comma-separated)</span>
          </label>
          <input
            className="input"
            value={values.tags}
            onChange={(e) => update("tags", e.target.value)}
            placeholder="client, project-x"
          />
        </div>
        <div className="field">
          <label>
            Notes <span className="hint">(visible to Claude)</span>
          </label>
          <textarea
            className="textarea"
            rows={4}
            value={values.notes}
            onChange={(e) => update("notes", e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
        {mode === "edit" && (
          <button type="button" className="btn btn-danger" onClick={remove}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
