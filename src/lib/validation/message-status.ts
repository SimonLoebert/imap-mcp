import { z } from "zod";
import { NOTE_MAX } from "@/lib/message-status";
import { MESSAGE_STATUSES } from "@/lib/message-status-types";

/** Body of PATCH /api/message-status/[id]: change a stored status. */
export const messageStatusUpdateSchema = z.object({
  status: z.enum(MESSAGE_STATUSES),
  holdUntil: z.string().trim().optional().nullable(),
  note: z.string().trim().max(NOTE_MAX).optional().nullable(),
});

/** Body of POST /api/message-status: give an untracked message a status. */
export const messageStatusCreateSchema = messageStatusUpdateSchema.extend({
  accountId: z.string().uuid(),
  folder: z.string().min(1),
  uid: z.number().int().positive(),
});
