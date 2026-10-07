import { and, arrayContains, arrayOverlaps, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, type Contact } from "@/lib/db/schema";
import type { ContactCreateInput, ContactUpdateInput } from "@/lib/validation/contact";

/** The stored row minus the tenant column — what REST and MCP hand out. */
export type ContactView = Omit<Contact, "userId">;

/** An address already belongs to another contact of the same user. */
export class ContactConflictError extends Error {
  constructor(
    readonly email: string,
    readonly existingId: string,
    readonly existingName: string,
  ) {
    super(
      `${email} already belongs to contact "${existingName}" (${existingId}) — update that contact instead of creating a duplicate`,
    );
    this.name = "ContactConflictError";
  }
}

const viewColumns = {
  id: contacts.id,
  name: contacts.name,
  emails: contacts.emails,
  phones: contacts.phones,
  organization: contacts.organization,
  jobTitle: contacts.jobTitle,
  salutation: contacts.salutation,
  notes: contacts.notes,
  tags: contacts.tags,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
};

function uniq(list: string[], key: (s: string) => string = (s) => s): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function normalizeEmails(list: string[]): string[] {
  return uniq(list.map((e) => e.toLowerCase()));
}

function normalizeTags(list: string[]): string[] {
  return uniq(list.map((t) => t.toLowerCase()));
}

function textOrNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function assertEmailsFree(userId: string, emails: string[], exceptId?: string) {
  if (emails.length === 0) return;
  const [clash] = await db
    .select({ id: contacts.id, name: contacts.name, emails: contacts.emails })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        arrayOverlaps(contacts.emails, emails),
        exceptId ? ne(contacts.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (clash) {
    const email = emails.find((e) => clash.emails.includes(e)) ?? emails[0];
    throw new ContactConflictError(email, clash.id, clash.name);
  }
}

export interface ListContactsOptions {
  /** Case-insensitive substring over name, addresses, organization, tags and notes. */
  query?: string;
  /** Exact address match (case-insensitive). */
  email?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export async function listContacts(userId: string, opts: ListContactsOptions = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const query = opts.query?.trim();
  const pattern = query ? `%${escapeLike(query)}%` : null;

  const rows = await db
    .select(viewColumns)
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        pattern
          ? or(
              ilike(contacts.name, pattern),
              ilike(contacts.organization, pattern),
              ilike(contacts.notes, pattern),
              sql`array_to_string(${contacts.emails}, ' ') ilike ${pattern}`,
              sql`array_to_string(${contacts.tags}, ' ') ilike ${pattern}`,
            )
          : undefined,
        opts.email ? arrayContains(contacts.emails, [opts.email.trim().toLowerCase()]) : undefined,
        opts.tag ? arrayContains(contacts.tags, [opts.tag.trim().toLowerCase()]) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${contacts.name})`), asc(contacts.id))
    .limit(limit + 1)
    .offset(offset);

  return { contacts: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function getContact(userId: string, id: string): Promise<ContactView | null> {
  const [row] = await db
    .select(viewColumns)
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function requireContact(userId: string, id: string): Promise<ContactView> {
  const row = await getContact(userId, id);
  if (!row) throw new Error(`Contact ${id} not found for current user`);
  return row;
}

export async function createContact(
  userId: string,
  input: ContactCreateInput,
): Promise<ContactView> {
  const emails = normalizeEmails(input.emails ?? []);
  await assertEmailsFree(userId, emails);

  const [row] = await db
    .insert(contacts)
    .values({
      userId,
      name: input.name.trim(),
      emails,
      phones: uniq(input.phones ?? []),
      organization: textOrNull(input.organization),
      jobTitle: textOrNull(input.jobTitle),
      salutation: textOrNull(input.salutation),
      notes: textOrNull(input.notes),
      tags: normalizeTags(input.tags ?? []),
    })
    .returning(viewColumns);
  return row;
}

/**
 * Patch semantics: `undefined` leaves a field alone, `null` clears an optional
 * text field, an array replaces the stored list. Returns null when the contact
 * does not exist for this user.
 */
export async function updateContact(
  userId: string,
  id: string,
  input: ContactUpdateInput,
): Promise<ContactView | null> {
  const patch: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.emails !== undefined) {
    patch.emails = normalizeEmails(input.emails);
    await assertEmailsFree(userId, patch.emails, id);
  }
  if (input.phones !== undefined) patch.phones = uniq(input.phones);
  if (input.organization !== undefined) patch.organization = textOrNull(input.organization);
  if (input.jobTitle !== undefined) patch.jobTitle = textOrNull(input.jobTitle);
  if (input.salutation !== undefined) patch.salutation = textOrNull(input.salutation);
  if (input.notes !== undefined) patch.notes = textOrNull(input.notes);
  if (input.tags !== undefined) patch.tags = normalizeTags(input.tags);

  const [row] = await db
    .update(contacts)
    .set(patch)
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
    .returning(viewColumns);
  return row ?? null;
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
    .returning({ id: contacts.id });
  return res.length > 0;
}
