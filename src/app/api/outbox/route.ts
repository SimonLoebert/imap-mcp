import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { approvalTtlHours, listPending } from "@/lib/outbox";
import { PENDING_STATUSES, type PendingMessageStatus } from "@/lib/outbox-types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await getCurrentUserRowId();
  const url = new URL(req.url);

  const requested = url.searchParams.getAll("status").flatMap((v) => v.split(","));
  const statuses = requested.filter((v): v is PendingMessageStatus =>
    (PENDING_STATUSES as readonly string[]).includes(v),
  );
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  const messages = await listPending(userId, {
    statuses: statuses.length ? statuses : undefined,
    limit,
  });
  return NextResponse.json({ messages, approvalTtlHours: approvalTtlHours() });
}
