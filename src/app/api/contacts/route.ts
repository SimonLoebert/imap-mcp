import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { ContactConflictError, createContact, listContacts } from "@/lib/contacts";
import { contactCreateSchema } from "@/lib/validation/contact";

export async function GET(req: Request) {
  const userId = await getCurrentUserRowId();
  const params = new URL(req.url).searchParams;
  const result = await listContacts(userId, {
    query: params.get("q") ?? undefined,
    tag: params.get("tag") ?? undefined,
    limit: Number(params.get("limit")) || undefined,
    offset: Number(params.get("offset")) || undefined,
  });
  return NextResponse.json({ contacts: result.contacts, has_more: result.hasMore });
}

export async function POST(req: Request) {
  const userId = await getCurrentUserRowId();
  const body = await req.json();
  const parsed = contactCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  try {
    const created = await createContact(userId, parsed.data);
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ContactConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
