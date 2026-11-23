import type { Member } from "../members/types.ts";
import { isSaturday } from "../members/attendance.ts";
import type { CalendarDay } from "../shared/time.ts";
import { isOvertimeReport } from "./header.ts";
import type { ReportKind } from "./types.ts";

/**
 * Which report (regular or lembur) a message's work lands in. Decided here,
 * deterministically and never by the model, from two sources: an overtime
 * header, or the owner's rule that staff-and-above working a Saturday are on
 * overtime by definition.
 *
 * ONE function for every path that stores a report — the live pipeline and
 * the admin reprocess scripts (via processReportContent's default) — so they
 * cannot diverge: a reprocessed "Report Lembur ..." once created a regular
 * report instead of revision 2 of the overtime one (found 2026-10-04).
 *
 * `text` must already be normalized (messages/normalize.ts).
 */
export function reportKindFor(text: string, reportingDay: CalendarDay, sender: Pick<Member, "level">): ReportKind {
  return isOvertimeReport(text) || (isSaturday(reportingDay) && sender.level !== "magang") ? "overtime" : "regular";
}
