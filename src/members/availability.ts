import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { memberAvailability, members } from "../db/schema.ts";
import type { Member } from "./types.ts";
import { addCalendarDays, fromJakartaWallClock, type CalendarDay } from "../shared/time.ts";

export type AvailabilityKind = typeof memberAvailability.$inferSelect["kind"];
export type MemberAvailability = typeof memberAvailability.$inferSelect;

/**
 * The kinds that mean "not in". `masuk` is deliberately NOT among them:
 * added 2026-08-29, it records the opposite — a member explicitly stating
 * they ARE coming in on a day they were not otherwise expected (a
 * non-magang Saturday). Every "is this person away" query filters on this
 * list rather than on "has any availability row", which would count a
 * presence declaration as an absence.
 */
export const ABSENCE_KINDS = ["izin", "cuti", "sakit", "not_scheduled"] as const satisfies readonly AvailabilityKind[];

/**
 * §15: a leave/sick/izin declaration covers exactly one calendar day —
 * multi-day leave is a repeated declaration, not a range, so "is this day
 * covered" stays a single half-open [start, start+1) window rather than an
 * open-ended range.
 *
 * WHICH day to pass in is deliberately the caller's decision, and the two
 * callers legitimately differ (§14: "'Today' lasts until the reporting
 * period closes at 09:59 the next day"):
 *  - DECLARING uses the calendar day — a member saying "saya sakit hari
 *    ini" at 08:00 means the workday about to start, not the reporting day
 *    still closing from yesterday.
 *  - CHECKING whether someone owed a report uses the REPORTING day, so it
 *    matches the reporting day the report lookup it's paired with uses.
 *    That combination is what actually implements §14's sentence: leave
 *    declared for Aug 12 keeps covering until 09:59 on Aug 13.
 */
function dayWindow(day: CalendarDay): { start: Date; end: Date } {
  const start = fromJakartaWallClock(day.year, day.month, day.day, 0, 0, 0, 0);
  const next = addCalendarDays(day, 1);
  const end = fromJakartaWallClock(next.year, next.month, next.day, 0, 0, 0, 0);
  return { start, end };
}

/** Rows covering `day` that have not been cancelled. */
function coversDay(day: CalendarDay) {
  const { start } = dayWindow(day);
  return and(
    lte(memberAvailability.startDate, start),
    or(isNull(memberAvailability.endDate), gt(memberAvailability.endDate, start)),
    isNull(memberAvailability.cancelledAt),
  );
}

/** As coversDay, restricted to the kinds that actually mean "away". */
function coversDayAsAbsence(day: CalendarDay) {
  return and(coversDay(day), inArray(memberAvailability.kind, [...ABSENCE_KINDS]));
}

export async function setAvailability(
  db: AppDatabase,
  memberId: string,
  kind: AvailabilityKind,
  day: CalendarDay,
  note?: string,
): Promise<MemberAvailability> {
  const { start, end } = dayWindow(day);
  const [row] = await db
    .insert(memberAvailability)
    .values({ memberId, kind, startDate: start, endDate: end, note: note ?? null })
    .returning();
  if (!row) throw new Error("member_availability insert returned no row");
  return row;
}

/**
 * §14's "an admin can correct or cancel it". Correcting needs no separate
 * path — a later declaration for the same day already wins in
 * getActiveAvailability. This is the retraction case: mark every
 * uncancelled declaration covering `day` as cancelled. Returns how many
 * were retracted so the caller can tell the member "there was nothing to
 * cancel" instead of silently reporting success.
 */
export async function cancelAvailability(
  db: AppDatabase,
  memberId: string,
  day: CalendarDay,
  cancelledByMemberId: string,
  now: Date = new Date(),
): Promise<number> {
  const cancelled = await db
    .update(memberAvailability)
    .set({ cancelledAt: now, cancelledByMemberId })
    .where(and(eq(memberAvailability.memberId, memberId), coversDay(day)))
    .returning({ availabilityId: memberAvailability.availabilityId });
  return cancelled.length;
}

/** Most recent uncancelled declaration covering `day` (a later declaration for the same day wins), or null if none. */
export async function getActiveAvailability(db: AppDatabase, memberId: string, day: CalendarDay): Promise<MemberAvailability | null> {
  const [row] = await db
    .select()
    .from(memberAvailability)
    .where(and(eq(memberAvailability.memberId, memberId), coversDay(day)))
    .orderBy(desc(memberAvailability.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listMembersOnLeave(db: AppDatabase, day: CalendarDay): Promise<Member[]> {
  const rows = await db
    .select({ member: members })
    .from(memberAvailability)
    .innerJoin(members, eq(memberAvailability.memberId, members.memberId))
    .where(and(eq(members.membershipStatus, "active"), coversDayAsAbsence(day)));

  const seen = new Map<string, Member>();
  for (const { member } of rows) seen.set(member.memberId, member);
  return [...seen.values()];
}

/**
 * memberId -> the kind covering `day`, for callers that need to RENDER the
 * kind rather than just test membership (the Sheets date tab writes
 * "cuti"/"izin"/"sakit" into the Aktivitas column). One query for the
 * whole day rather than N getActiveAvailability calls — a date tab covers
 * every active member.
 */
export async function getAvailabilityKindsForDay(db: AppDatabase, day: CalendarDay): Promise<Map<string, AvailabilityKind>> {
  const rows = await db
    .select({
      memberId: memberAvailability.memberId,
      kind: memberAvailability.kind,
      createdAt: memberAvailability.createdAt,
    })
    .from(memberAvailability)
    .where(coversDay(day))
    .orderBy(memberAvailability.createdAt);

  // Ascending order + overwrite means the LAST (most recent) declaration
  // wins, matching getActiveAvailability's "a later declaration for the
  // same day wins" rule. Both must agree or the sheet and the reminders
  // would disagree about the same member on the same day.
  const byMemberId = new Map<string, AvailabilityKind>();
  for (const row of rows) byMemberId.set(row.memberId, row.kind);
  return byMemberId;
}

/**
 * How many days in [from, to] inclusive the member had an uncancelled
 * declaration. Used by the weekly wrap-up so leave days don't count
 * against report compliance (a member on 3 days' cuti was showing as 3/6
 * — indistinguishable from someone who simply didn't report).
 */
export async function countLeaveDaysInRange(
  db: AppDatabase,
  memberId: string,
  from: CalendarDay,
  to: CalendarDay,
): Promise<number> {
  let count = 0;
  let cursor = from;
  // Bounded by construction: every caller passes a single week.
  for (let guard = 0; guard < 400; guard++) {
    const active = await getActiveAvailability(db, memberId, cursor);
    // ABSENCE kinds only. getActiveAvailability returns whatever was last
    // declared, and since 2026-08-29 that can be `masuk` — a statement of
    // PRESENCE. Counting it as a leave day would reduce what the member
    // owes precisely because they said they were coming in.
    if (active && (ABSENCE_KINDS as readonly string[]).includes(active.kind)) count++;
    if (cursor.year === to.year && cursor.month === to.month && cursor.day === to.day) break;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}
