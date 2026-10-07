import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailAccounts } from "@/lib/db/schema";
import { getCurrentUserRowId } from "@/lib/auth/clerk";
import { encrypt } from "@/lib/crypto";
import { sanitizeSignatureHtml } from "@/lib/smtp";
import { accountCreateSchema } from "@/lib/validation/account";
import { generatePgpKey } from "@/lib/pgp";

export async function GET() {
  const userId = await getCurrentUserRowId();
  const rows = await db
    .select({
      id: mailAccounts.id,
      label: mailAccounts.label,
      email: mailAccounts.email,
      fromName: mailAccounts.fromName,
      imapHost: mailAccounts.imapHost,
      imapPort: mailAccounts.imapPort,
      imapSecure: mailAccounts.imapSecure,
      imapUser: mailAccounts.imapUser,
      smtpHost: mailAccounts.smtpHost,
      smtpPort: mailAccounts.smtpPort,
      smtpSecure: mailAccounts.smtpSecure,
      smtpUser: mailAccounts.smtpUser,
      signatureHtml: mailAccounts.signatureHtml,
      writingStyle: mailAccounts.writingStyle,
      requireSendApproval: mailAccounts.requireSendApproval,
      approvalAllowlist: mailAccounts.approvalAllowlist,
      pgpFingerprint: mailAccounts.pgpFingerprint,
      pgpSignByDefault: mailAccounts.pgpSignByDefault,
      pgpAttachPublicKey: mailAccounts.pgpAttachPublicKey,
      isDefault: mailAccounts.isDefault,
      createdAt: mailAccounts.createdAt,
    })
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId))
    .orderBy(mailAccounts.createdAt);
  return NextResponse.json({ accounts: rows });
}

export async function POST(req: Request) {
  const userId = await getCurrentUserRowId();
  const body = await req.json();
  const parsed = accountCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const input = parsed.data;

  if (input.isDefault) {
    await db
      .update(mailAccounts)
      .set({ isDefault: false })
      .where(eq(mailAccounts.userId, userId));
  } else {
    const existingCount = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, userId));
    if (existingCount.length === 0) {
      input.isDefault = true;
    }
  }

  const pgpSignByDefault = input.pgpSignByDefault ?? true;
  const pgpAttachPublicKey = input.pgpAttachPublicKey ?? true;
  // Give the account its signing identity right away, so the owner can see
  // and publish the fingerprint before the first mail goes out.
  const pgpKey =
    pgpSignByDefault || pgpAttachPublicKey
      ? await generatePgpKey(input.email, input.fromName)
      : null;

  const [created] = await db
    .insert(mailAccounts)
    .values({
      userId,
      label: input.label,
      email: input.email,
      fromName: input.fromName?.trim() || null,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      imapUser: input.imapUser,
      imapPasswordEnc: encrypt(input.imapPassword),
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpUser: input.smtpUser,
      smtpPasswordEnc: encrypt(input.smtpPassword),
      signatureHtml: input.signatureHtml ? sanitizeSignatureHtml(input.signatureHtml) : null,
      writingStyle: input.writingStyle ?? null,
      // Human-in-the-loop is on unless the account owner opts out.
      requireSendApproval: input.requireSendApproval ?? true,
      approvalAllowlist: input.approvalAllowlist ?? [],
      pgpSignByDefault,
      pgpAttachPublicKey,
      pgpPrivateKeyEnc: pgpKey?.privateKeyEnc ?? null,
      pgpPublicKey: pgpKey?.publicKey ?? null,
      pgpFingerprint: pgpKey?.fingerprint ?? null,
      isDefault: input.isDefault ?? false,
    })
    .returning({ id: mailAccounts.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
