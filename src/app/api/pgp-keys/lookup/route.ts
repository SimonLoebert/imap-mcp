import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { normalizeEmail, resolveRecipientKeys } from "@/lib/pgp-keyring";

const lookupSchema = z.object({ email: z.string().email() });

/** Look an address up in the keyring and, failing that, its Web Key Directory. */
export async function POST(req: Request) {
  const userId = await getCurrentUserRowId();
  const parsed = lookupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const email = normalizeEmail(parsed.data.email);
  const { keys } = await resolveRecipientKeys(userId, [email], { wkd: true });
  const hit = keys.get(email);
  return NextResponse.json(
    hit
      ? { found: true, email, fingerprint: hit.fingerprint, source: hit.source }
      : { found: false, email },
  );
}
