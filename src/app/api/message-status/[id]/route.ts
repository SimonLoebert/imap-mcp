import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import {
  deleteStatus,
  MessageStatusInputError,
  updateStatusById,
} from "@/lib/message-status";
import { messageStatusUpdateSchema } from "@/lib/validation/message-status";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  if (!uuidRe.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json();
  const parsed = messageStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  try {
    const row = await updateStatusById(userId, id, parsed.data);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ status: row });
  } catch (e) {
    if (e instanceof MessageStatusInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
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
  const ok = uuidRe.test(id) && (await deleteStatus(userId, id));
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
