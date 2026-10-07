import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import {
  ContactConflictError,
  deleteContact,
  getContact,
  updateContact,
} from "@/lib/contacts";
import { contactUpdateSchema } from "@/lib/validation/contact";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const row = uuidRe.test(id) ? await getContact(userId, id) : null;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ contact: row });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  if (!uuidRe.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const parsed = contactUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  try {
    const row = await updateContact(userId, id, parsed.data);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ContactConflictError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const ok = uuidRe.test(id) && (await deleteContact(userId, id));
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
