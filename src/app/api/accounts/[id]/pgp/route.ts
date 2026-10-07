import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailAccounts } from "@/lib/db/schema";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { describePublicKey, generatePgpKey, importPgpKey, publicKeyFilename } from "@/lib/pgp";
import { pgpKeyActionSchema } from "@/lib/validation/account";

/**
 * The account's public key. `?download=1` serves it as an .asc file; the
 * private key never leaves the server through this or any other route.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const [row] = await db
    .select({ publicKey: mailAccounts.pgpPublicKey, fingerprint: mailAccounts.pgpFingerprint })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!row.publicKey || !row.fingerprint) return NextResponse.json({ key: null });

  if (new URL(req.url).searchParams.get("download")) {
    return new NextResponse(row.publicKey, {
      headers: {
        "content-type": "application/pgp-keys",
        "content-disposition": `attachment; filename="${publicKeyFilename(row.fingerprint)}"`,
      },
    });
  }
  return NextResponse.json({
    key: { ...(await describePublicKey(row.publicKey)), publicKey: row.publicKey },
  });
}

/** Replace the account's key — generate a fresh one or import the owner's own. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserRowId();
  const parsed = pgpKeyActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const [acc] = await db
    .select({ email: mailAccounts.email, fromName: mailAccounts.fromName })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)))
    .limit(1);
  if (!acc) return NextResponse.json({ error: "not found" }, { status: 404 });

  let material;
  try {
    material =
      parsed.data.action === "generate"
        ? await generatePgpKey(acc.email, acc.fromName)
        : await importPgpKey(parsed.data.armoredKey, parsed.data.passphrase);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  // The outgoing key is retired, not dropped: mail already encrypted to it
  // has to stay readable.
  await db
    .update(mailAccounts)
    .set({
      pgpPreviousKeysEnc: sql`case when ${mailAccounts.pgpPrivateKeyEnc} is null
        then ${mailAccounts.pgpPreviousKeysEnc}
        else array_append(${mailAccounts.pgpPreviousKeysEnc}, ${mailAccounts.pgpPrivateKeyEnc}) end`,
      pgpPrivateKeyEnc: material.privateKeyEnc,
      pgpPublicKey: material.publicKey,
      pgpFingerprint: material.fingerprint,
      updatedAt: new Date(),
    })
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)));

  return NextResponse.json({ key: await describePublicKey(material.publicKey) });
}
