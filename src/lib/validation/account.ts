import { z } from "zod";
import { writingStyleSchema } from "@/lib/writing-style";
import { allowlistSchema } from "@/lib/allowlist";

export const accountCreateSchema = z.object({
  label: z.string().min(1).max(80),
  email: z.string().email(),
  fromName: z.string().max(120).optional().nullable(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  imapUser: z.string().min(1),
  imapPassword: z.string().min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().min(1),
  smtpPassword: z.string().min(1),
  signatureHtml: z.string().max(20000).optional().nullable(),
  writingStyle: writingStyleSchema.optional().nullable(),
  requireSendApproval: z.boolean().optional(),
  approvalAllowlist: allowlistSchema.optional(),
  pgpSignByDefault: z.boolean().optional(),
  pgpAttachPublicKey: z.boolean().optional(),
  pgpAutoEncrypt: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const accountUpdateSchema = accountCreateSchema.partial().extend({
  imapPassword: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
});

/** Replace an account's OpenPGP key: generate a fresh one or import an armored private key. */
export const pgpKeyActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate") }),
  z.object({
    action: z.literal("import"),
    armoredKey: z.string().min(1).max(200_000),
    passphrase: z.string().max(1000).optional(),
  }),
]);

/** Owner-side keyring import; `replace` may overwrite an existing key for an address. */
export const keyringImportSchema = z.object({
  armoredKey: z.string().min(1).max(500_000),
  replace: z.boolean().optional(),
});

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;
