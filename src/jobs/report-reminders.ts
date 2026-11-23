import type { AppDatabase } from "../db/types.ts";
import { listActiveMembers } from "../members/service.ts";
import type { Member } from "../members/types.ts";
import { getAttendanceExpectations } from "../members/attendance.ts";
import { isEligibleForReminder } from "../permissions/engine.ts";
import { getDailyReport } from "../reports/service.ts";
import { formatCalendarDay, reportingDayFor } from "../shared/time.ts";

/**
 * MASTER_SPEC.md §9.4: 20:00 first reminder, 22:30 final reminder,
 * Monday-Saturday. §9.6: a no-activity report still counts as "reported"
 * for this purpose even while pending_admin_confirmation — the member
 * submitted something, they're just not missing. (d3): a member on
 * declared leave/izin/sakit isn't missing either.
 *
 * The leave lookup MUST use the same reporting day as the report lookup
 * below, not the calendar day (fixed 2026-08-12). They diverge between
 * 00:00 and 09:59, and while the 20:00/22:30 reminder jobs never run in
 * that window, the "@helper siapa yang belum lapor?" query can be asked at
 * any hour — at 08:00 it compared yesterday's reports against today's
 * leave, so a member on leave yesterday was reported as not having
 * reported. Keying both to the reporting day is also exactly what §14's
 * "'Today' lasts until the reporting period closes at 09:59 the next day"
 * describes: leave declared for Aug 12 keeps covering until 09:59 Aug 13.
 */
export async function listMissingReporters(db: AppDatabase, now: Date = new Date()): Promise<Member[]> {
  const reportingDay = reportingDayFor(now);
  const reportingDayLabel = formatCalendarDay(reportingDay);
  const activeMembers = await listActiveMembers(db);

  // One shared rule for "is a report owed today", also used by the Sheets
  // date tab and the weekly compliance figure. It covers declared absence
  // AND the Saturday exemption for everyone above magang.
  const expectations = await getAttendanceExpectations(db, reportingDay);

  const missing: Member[] = [];
  for (const member of activeMembers) {
    if (!isEligibleForReminder(member)) continue;
    if (expectations.get(member.memberId)?.expected !== true) continue;
    const report = await getDailyReport(db, member.memberId, reportingDayLabel);
    if (!report) missing.push(member);
  }
  return missing;
}
