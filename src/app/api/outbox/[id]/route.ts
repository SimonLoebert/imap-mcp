import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import {
  OutboxStateError,
  approveAndSend,
  deletePending,
  getPending,
  rejectPending,
  retryFailed,
} from "@/lib/outbox";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  action: z.enum(["approve", "reject", "retry"]),
  note: z.string().max(500).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const message = await getPending(userId, id);
  if (!message) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ message });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const parsed = actionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  try {
    if (parsed.data.action === "approve") {
      const { summary, send } = await approveAndSend(userId, id, parsed.data.note);
      // A failed SMTP handover is not a client error — the decision was
      // recorded, so report 200 with the failure detail on the message.
      return NextResponse.json({ message: summary, send });
    }
    if (parsed.data.action === "retry") {
      return NextResponse.json({ message: await retryFailed(userId, id) });
    }
    return NextResponse.json({
      message: await rejectPending(userId, id, parsed.data.note),
    });
  } catch (e) {
    if (e instanceof OutboxStateError) {
      return NextResponse.json(
        { error: e.message, status: e.status },
        { status: e.status === null ? 404 : 409 },
      );
    }
    throw e;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const existing = await getPending(userId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "pending" || existing.status === "sending") {
    return NextResponse.json(
      { error: "reject the message before deleting it", status: existing.status },
      { status: 409 },
    );
  }
  await deletePending(userId, id);
  return NextResponse.json({ ok: true });
}
