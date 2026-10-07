import Link from "next/link";
import { ContactForm } from "@/components/ContactForm";

export default function NewContactPage() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link href="/contacts" className="muted">
          ← Back
        </Link>
      </div>
      <h2 style={{ marginBottom: 24 }}>New contact</h2>
      <ContactForm mode="create" />
    </div>
  );
}
