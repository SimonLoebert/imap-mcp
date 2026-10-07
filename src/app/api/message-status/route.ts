import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { loadAccount } from "@/lib/mcp/context";
import { MessageStatusInputError, setStatusForUids } from "@/lib/message-status";
import { messageStatusCreateSchema } from "@/lib/validation/message-status";

export async function POST(req: Request) {
  const userId = await getCurrentUserRowId();
  const body = await req.json();
  const parsed = messageStatusCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const { accountId, folder, uid, ...input } = parsed.data;
  const account = await loadAccount(userId, accountId);
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const res = await setStatusForUids(account, folder, [uid], input, null);
    if (res.updated.length === 0) {
      return NextResponse.json(
        { error: "message not found — it may have been moved or deleted" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, ...res.updated[0] });
  } catch (e) {
    if (e instanceof MessageStatusInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
