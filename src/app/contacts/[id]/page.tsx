import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { getContact } from "@/lib/contacts";
import { ContactForm } from "@/components/ContactForm";

export const dynamic = "force-dynamic";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!uuidRe.test(id)) notFound();
  const userId = await getCurrentUserRowId();
  const contact = await getContact(userId, id);
  if (!contact) notFound();

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link href="/contacts" className="muted">
          ← Back
        </Link>
      </div>
      <h2 style={{ marginBottom: 24 }}>{contact.name}</h2>
      <ContactForm
        mode="edit"
        contactId={contact.id}
        initial={{
          name: contact.name,
          emails: contact.emails.join("\n"),
          phones: contact.phones.join("\n"),
          organization: contact.organization ?? "",
          jobTitle: contact.jobTitle ?? "",
          salutation: contact.salutation ?? "",
          notes: contact.notes ?? "",
          tags: contact.tags.join(", "),
        }}
      />
    </div>
  );
}
