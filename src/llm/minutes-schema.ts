import { z } from "zod";

/**
 * Meeting-minutes intake (owner request 2026-08-29). Minutes arrive as
 * free-form prose — "jangan harap notulensinya rapih dan dengan format
 * tetap, bisa jadi berbentuk paragraf panjang" — which is exactly what an
 * LLM is for. What it is NOT for is deciding anything:
 *
 *   - assigneeNames are RAW TEXT the model copied out of the minutes.
 *     Resolving them to real members is the backend's job
 *     (resolveMembersByNameOrAlias), and 0 or >1 matches must never be
 *     guessed — the established rule everywhere else in this codebase.
 *   - deadlineText is likewise RAW TEXT ("tanggal 10", "minggu depan").
 *     The backend computes the actual date. Letting the model emit a
 *     calendar date is the exact bug class that corrupted a report on
 *     2026-08-08, and MASTER_SPEC.md §3.6 lists deadline calculation among
 *     the things never delegated to the LLM.
 *
 * Every field except the title is optional and nullable, per the safety
 * rule earned the hard way: a model omitting a field must not cost us the
 * whole extraction. `title` alone is required, because an action item
 * without one describes nothing.
 */
export const ExtractedActionItemSchema = z.object({
  /** What is to be done, as a task title. */
  title: z.string().min(1),
  /** Any extra context worth keeping on the task — not parsed further. */
  notes: z.string().nullable().optional(),
  /** Names EXACTLY as written in the minutes. Resolution happens in the backend. */
  assigneeNames: z.array(z.string()).max(10).nullable().optional(),
  /** Deadline as written ("tanggal 10", "akhir bulan"). Never a computed date. */
  deadlineText: z.string().nullable().optional(),
  /** Project as written, if the minutes name one. Resolved deterministically later. */
  projectText: z.string().nullable().optional(),
});
export type ExtractedActionItem = z.infer<typeof ExtractedActionItemSchema>;

/**
 * Same refine rule as ReportExtractionSchema, for the same reason: a
 * default may stand in for a field the model FORGOT, never for an answer
 * it never gave. Minutes with no action items at all are legitimate (a
 * purely informational meeting), so that must be stated explicitly via
 * `noActionItems` rather than inferred from an empty list.
 */
export const MeetingMinutesExtractionSchema = z
  .object({
    /** One-line gist of what the meeting was about, for the task's source reference. */
    summary: z.string().nullable().optional(),
    noActionItems: z.boolean().default(false),
    actionItems: z.array(ExtractedActionItemSchema).max(40).default([]),
  })
  .refine((m) => m.noActionItems || m.actionItems.length > 0, {
    message: "actionItems is empty while noActionItems is false — say noActionItems: true if the meeting produced none",
  });
export type MeetingMinutesExtraction = z.infer<typeof MeetingMinutesExtractionSchema>;
