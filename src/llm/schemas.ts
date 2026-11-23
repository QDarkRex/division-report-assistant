import { z } from "zod";
import { availabilityKindEnum, obstacleCategoryEnum, reportItemStatusEnum } from "../db/schema.ts";

/**
 * MASTER_SPEC.md §2/§4: the LLM is not the source of truth — every
 * response is validated against one of these schemas before it can touch
 * the database. `reportItemStatusEnum.enumValues` is imported rather than
 * re-listed here so the Zod contract can't silently drift from the DB
 * enum the way task_status did (see the chief-review fix in schema.ts).
 */

export const ReportItemStatusSchema = z.enum(reportItemStatusEnum.enumValues);
export const ObstacleCategorySchema = z.enum(obstacleCategoryEnum.enumValues);
export const AvailabilityKindSchema = z.enum(availabilityKindEnum.enumValues);

export const MessageClassificationSchema = z.object({
  category: z.enum(["daily_report", "query", "noise", "command", "clarification_response", "unknown"]),
});
export type MessageClassification = z.infer<typeof MessageClassificationSchema>;

export const ExtractedReportItemSchema = z.object({
  activity: z.string().min(1),
  result: z.string().nullable().optional(),
  obstacle: z.string().nullable().optional(),
  // Optional+nullable is load-bearing, not a style choice: today's live
  // incident (pipeline.ts's report_extraction_failed fix) was DeepSeek
  // omitting a REQUIRED field, burning 3 repair attempts, and silently
  // dropping a real member's report. Making this field required would
  // repeat that exact failure the moment the model omits it. Omitted ->
  // null (not classified), never a lost report.
  obstacleCategory: ObstacleCategorySchema.nullable().optional(),
  status: ReportItemStatusSchema,
  matchedTaskId: z.string().uuid().nullable().optional(),
  /**
   * How sure the model is that matchedTaskId is the same job. Only the
   * pipeline's plan-task path reads it: "high" links straight away, anything
   * else (including omitted, or a word the model invented) is treated as
   * "low" and asked about first. `.catch(undefined)` is deliberate — an
   * off-spec value here must degrade to the cautious "low" reading, not burn
   * a repair attempt and risk losing the whole report (see the note on
   * obstacleCategory above).
   */
  matchConfidence: z.enum(["high", "low"]).nullable().optional().catch(undefined),
  /** One short phrase on why it matched; shown to admins, never acted on. The pipeline truncates it rather than rejecting a long one. */
  matchReason: z.string().nullable().optional().catch(undefined),
});
export type ExtractedReportItem = z.infer<typeof ExtractedReportItemSchema>;

/**
 * §4.5 item 4: extract activity/result/obstacle/status and candidates in
 * one call — bounded to §9's "3-5 most relevant" candidates.
 *
 * BOTH fields default rather than being required, and that is a safety
 * rule in this codebase rather than a style preference. Every recorded
 * extraction failure so far has been DeepSeek omitting a required
 * top-level field — `noActivity` on 2026-08-08, `items` on 2026-08-10 —
 * burning all three repair attempts and losing a real member's report.
 * A model that omits a field is not telling us the report was empty, but
 * an empty report that gets stored (and can be corrected by a revision,
 * or reprocessed from the durably-stored raw text) beats a real report
 * that is silently thrown away. Same reasoning as
 * ExtractedReportItemSchema.obstacleCategory above.
 */
export const ReportExtractionSchema = z
  .object({
    noActivity: z.boolean().default(false),
    items: z.array(ExtractedReportItemSchema).max(20).default([]),
  })
  // The defaults above cover a field the model FORGOT. They must not also
  // wave through a result that is self-contradictory: "this report has
  // activity" plus an empty activity list describes nothing that can exist.
  //
  // Found live 2026-08-29 from a real report of Affan's that acknowledged
  // as "0 aktivitas". Re-running that exact text three times returned three
  // different shapes — correct once, missing noActivity once, and malformed
  // JSON once — so the model is simply unstable on this input. Before the
  // defaults were added (2026-08-12) a missing field failed validation and
  // the repair loop retried, usually successfully. After, it validated
  // instantly as an empty report and 26 real reports were silently stored
  // with none of their content.
  //
  // Rejecting the contradiction here routes it back into the SAME bounded
  // repair loop that used to catch it, without giving up the protection
  // against a merely-omitted field. A genuine no-activity report
  // (noActivity: true, items: []) is unaffected.
  .refine((extraction) => extraction.noActivity || extraction.items.length > 0, {
    message: "items is empty while noActivity is false — a report with content must yield at least one activity",
  });
export type ReportExtraction = z.infer<typeof ReportExtractionSchema>;

/**
 * MASTER_SPEC.md §16's 8 example queries map to these 8 read-only intents,
 * plus (d3) `set_availability` — the one mutating intent in this schema —
 * and `unknown`. The LLM only extracts intent + parameters here — it never
 * generates the answer text itself (../queries/format.ts does that from
 * real query results, no LLM involved at all in formatting), and for
 * set_availability it never performs the write itself either
 * (../queries/executors.ts does, after a deterministic permission check).
 *
 * `dayOffset` is an INTEGER OFFSET (0 = today, -1 = yesterday, +1 =
 * besok), never a date string — the backend computes the actual calendar
 * day via reportingDayFor()/addCalendarDays(). Letting the model emit a
 * date string directly would repeat the exact bug class that already
 * corrupted a report today (reprocess-message.ts's date-handling bug,
 * 2026-08-08) — never let the LLM decide what calendar day something
 * happened on. Range widened to +14 for (d3): leave is commonly declared
 * a few days ahead ("besok saya izin", "minggu depan saya cuti").
 *
 * `additionalDayOfMonths` carries dates the member wrote as bare numbers
 * ("begitu juga di tanggal 12,19,26 mendatang"). It stays a DAY NUMBER,
 * not an offset and not a date string, for the same reason dayOffset is an
 * offset: converting "tanggal 12" into a calendar day is arithmetic, and
 * the model must not do arithmetic about dates. It reports the number it
 * read; availabilityDaysFor() resolves each to its next occurrence.
 *
 * Added 2026-09-04 after a real declaration was silently truncated: Andre
 * wrote "Besok izin gak masuk ... begitu juga di tanggal 12,19,26
 * mendatang" and only tomorrow was stored. The three later dates were not
 * rejected or questioned — the schema simply had nowhere to put them, so
 * they vanished and nobody would have known until he was marked absent
 * without notice.
 */
export const QueryIntentSchema = z.object({
  intent: z.enum([
    "tasks_today",
    "nearest_deadline",
    "member_tasks",
    "missing_reporters",
    "task_status",
    "member_report",
    "stale_tasks",
    "project_summary",
    "overtime_today",
    "overtime_checkin",
    "overtime_checkout",
    "create_task",
    "export_daily_report",
    "set_availability",
    "cancel_availability",
    "unknown",
  ]),
  targetMemberName: z.string().nullable().optional(),
  /**
   * Several people at once, for intents that legitimately name more than
   * one ("tugaskan Nisa dan Udin ..."). Separate from targetMemberName
   * rather than replacing it: the read-only intents ask about exactly one
   * person, and widening them would turn "laporan Nisa" into a question
   * with no single answer.
   *
   * Every name here must resolve to exactly one member or the whole
   * request is refused — the same rule as everywhere else in this system.
   * A task assigned to the wrong person is chased from the wrong person.
   */
  targetMemberNames: z.array(z.string()).max(20).nullable().optional(),
  /** The task being created, in the requester's own words. */
  taskTitle: z.string().max(200).nullable().optional(),
  taskReference: z.string().nullable().optional(),
  projectReference: z.string().nullable().optional(),
  dayOffset: z.number().int().min(-30).max(14).nullable().optional(),
  /** Bare day-of-month numbers from the message, resolved by the backend. Capped: a declaration is a handful of days, not a calendar. */
  additionalDayOfMonths: z.array(z.number().int().min(1).max(31)).max(12).nullable().optional(),
  // Optional+nullable, same rule as obstacleCategory above: the model
  // omitting this must fall through to "ask, don't guess" in the
  // executor, never silently drop or misclassify the intent.
  availabilityKind: AvailabilityKindSchema.nullable().optional(),
  /**
   * Why they are out, in their own words ("bimbingan skripsi", "diare").
   * Owner request 2026-08-29: optional, but there must be somewhere to
   * put it. Capped so one member's explanation cannot turn a spreadsheet
   * cell into an essay — a reason is a phrase, not a paragraph.
   */
  availabilityReason: z.string().max(200).nullable().optional(),
  /**
   * A clock time exactly as the member wrote it ("17:00", "jam 5 sore"),
   * for overtime check-in/checkout. Stored verbatim and never parsed into a
   * structured time — turning free clock-talk into a timestamp is a guess,
   * and the owner reads these strings directly. Absent when none was given.
   */
  timeText: z.string().max(40).nullable().optional(),
});
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export const ClarificationRequestSchema = z.object({
  question: z.string().min(1),
  reason: z.string().min(1),
});
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
