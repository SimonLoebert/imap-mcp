import { z } from "zod";

/**
 * Field rules shared by the REST API and the MCP tools. Optional text fields
 * accept `null` (clear) as well as a string; arrays always replace the stored
 * list wholesale.
 */
export const contactLimits = {
  name: 200,
  shortText: 200,
  salutation: 200,
  notes: 5000,
  emails: 20,
  phones: 20,
  phone: 50,
  tags: 30,
  tag: 50,
} as const;

const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const contactCreateSchema = z.object({
  name: z.string().trim().min(1).max(contactLimits.name),
  emails: z.array(z.string().trim().email()).max(contactLimits.emails).optional(),
  phones: z
    .array(z.string().trim().min(1).max(contactLimits.phone))
    .max(contactLimits.phones)
    .optional(),
  organization: optionalText(contactLimits.shortText),
  jobTitle: optionalText(contactLimits.shortText),
  salutation: optionalText(contactLimits.salutation),
  notes: optionalText(contactLimits.notes),
  tags: z
    .array(z.string().trim().min(1).max(contactLimits.tag))
    .max(contactLimits.tags)
    .optional(),
});

export const contactUpdateSchema = contactCreateSchema.partial();

export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
