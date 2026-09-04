import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import {
  OutboxStateError,
  addAttachments,
  maxAttachmentBytes,
  maxAttachmentCount,
  removeAttachment,
  type ReviewerAttachmentInput,
} from "@/lib/outbox";

export const dynamic = "force-dynamic";

/** Guard the request itself before anything is buffered into the payload. */
const MAX_FILES_PER_REQUEST = 10;

function stateError(e: OutboxStateError) {
  return NextResponse.json(
    { error: e.message, status: e.status },
    { status: e.status === null ? 404 : 409 },
  );
}

/**
 * Attach files to a message waiting in the outbox. Human-only: it sits behind
 * Clerk like every other `/api/outbox` route, so an MCP client can never bolt
 * a file onto a draft the owner is reviewing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected a multipart/form-data body" }, { status: 400 });
  }

  const uploads = form.getAll("files").filter((v): v is File => v instanceof File);
  if (uploads.length === 0) {
    return NextResponse.json({ error: "no files in the request" }, { status: 400 });
  }
  if (uploads.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `at most ${MAX_FILES_PER_REQUEST} files per upload` },
      { status: 400 },
    );
  }

  let bytes = 0;
  const files: ReviewerAttachmentInput[] = [];
  for (const upload of uploads) {
    if (upload.size === 0) {
      return NextResponse.json(
        { error: `"${upload.name || "file"}" is empty` },
        { status: 400 },
      );
    }
    bytes += upload.size;
    if (bytes > maxAttachmentBytes()) {
      return NextResponse.json(
        {
          error: `upload exceeds the ${Math.round(
            maxAttachmentBytes() / 1024 / 1024,
          )} MB limit for a message awaiting approval`,
        },
        { status: 413 },
      );
    }
    files.push({
      filename: upload.name,
      contentBase64: Buffer.from(await upload.arrayBuffer()).toString("base64"),
      contentType: upload.type || undefined,
    });
  }

  try {
    const message = await addAttachments(userId, id, files);
    return NextResponse.json({ message, maxAttachmentCount: maxAttachmentCount() });
  } catch (e) {
    if (e instanceof OutboxStateError) return stateError(e);
    throw e;
  }
}

/** Remove one attachment (`?index=`) from a message still awaiting a decision. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();

  const raw = new URL(req.url).searchParams.get("index");
  const index = Number(raw);
  if (raw === null || !Number.isInteger(index) || index < 0) {
    return NextResponse.json(
      { error: "index query parameter must be a non-negative integer" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ message: await removeAttachment(userId, id, index) });
  } catch (e) {
    if (e instanceof OutboxStateError) return stateError(e);
    throw e;
  }
}
