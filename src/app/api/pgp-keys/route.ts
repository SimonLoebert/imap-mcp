import { NextResponse } from "next/server";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { importKey, listKeyring, parsePublicKeys, type ImportResult } from "@/lib/pgp-keyring";
import { keyringImportSchema } from "@/lib/validation/account";

export async function GET() {
  const userId = await getCurrentUserRowId();
  return NextResponse.json({ keys: await listKeyring(userId) });
}

/** Import a pasted key. Only here — behind Clerk — may `replace` swap an existing key. */
export async function POST(req: Request) {
  const userId = await getCurrentUserRowId();
  const parsed = keyringImportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  try {
    const results: ImportResult[] = [];
    for (const key of await parsePublicKeys(parsed.data.armoredKey)) {
      results.push(...(await importKey(userId, key, "manual", { replace: parsed.data.replace })));
    }
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
