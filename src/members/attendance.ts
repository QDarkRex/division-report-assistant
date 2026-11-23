import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { memberAvailability, members } from "../db/schema.ts";
import type { Member } from "./types.ts";
import { ABSENCE_KINDS, type AvailabilityKind } from "./availability.ts";
import { dayOfWeek, fromJakartaWallClock, type CalendarDay } from "../shared/time.ts";

/**
 * One answer to "is this member expected to file a report on this day",
 * shared by the reminder job, the weekly compliance figure, and the Sheets
 * date tab. They must agree: a member excused from Saturday must also not
 * be nagged for it, and must not be scored as non-compliant. Three
 * separate reimplementations of that rule is exactly how the
 * calendar-day/reporting-day mismatch got in (fixed 2026-08-12).
 *
 * The Saturday rule, owner 2026-08-29: only magang are required in on
 * Saturdays. For everyone else a Saturday with no report means "tidak
 * masuk", not "belum lapor" — unless they said otherwise, which is what
 * the `masuk` availability kind records.
 */
const SATURDAY = 6;

export type AttendanceExpectation =
  | { expected: true }
  /** `note` is the member's own words for why ("bimbingan skripsi"), or null if they gave none. */
  | { expected: false; reason: "away"; kind: AvailabilityKind; note: string | null }
  | { expected: false; reason: "saturday_off" };

export function isSaturday(day: CalendarDay): boolean {
  return dayOfWeek(day) === SATURDAY;
}

/** Only magang owe a report on Saturdays. */
export function isSaturdayOptionalFor(member: Pick<Member, "level">): boolean {
  return member.level !== "magang";
}

/**
 * Batched deliberately: the date tab and the reminder job both need this
 * for every active member at once, and doing it per member would mean one
 * query each across a 20-plus person roster.
 *
 * Members who are inactive or not required to report at all are simply
 * absent from the returned map — they are not "expected" in any sense the
 * callers care about, and the callers already filter them.
 */
export async function getAttendanceExpectations(
  db: AppDatabase,
  day: CalendarDay,
): Promise<Map<string, AttendanceExpectation>> {
  const activeMembers = await db.select().from(members).where(eq(members.membershipStatus, "active"));
  const declarations = await db
    .select({
      memberId: memberAvailability.memberId,
      kind: memberAvailability.kind,
      note: memberAvailability.note,
      createdAt: memberAvailability.createdAt,
      startDate: memberAvailability.startDate,
      endDate: memberAvailability.endDate,
      cancelledAt: memberAvailability.cancelledAt,
    })
    .from(memberAvailability)
    .orderBy(memberAvailability.createdAt);

  // Latest uncancelled declaration covering `day`, per member — ascending
  // order plus overwrite, matching getActiveAvailability's "a later
  // declaration for the same day wins".
  //
  // fromJakartaWallClock, never hand-rolled offset arithmetic: doing that
  // by hand is the documented bug class in this codebase (Date.getDay()
  // in date-tabs.ts, new Date() in reprocess-message.ts), and it has
  // corrupted real data twice.
  const start = fromJakartaWallClock(day.year, day.month, day.day, 0, 0, 0, 0);
  const declaredByMemberId = new Map<string, { kind: AvailabilityKind; note: string | null }>();
  for (const row of declarations) {
    if (row.cancelledAt) continue;
    if (row.startDate > start) continue;
    if (row.endDate && row.endDate <= start) continue;
    declaredByMemberId.set(row.memberId, { kind: row.kind, note: row.note });
  }

  const saturday = isSaturday(day);
  const expectations = new Map<string, AttendanceExpectation>();

  for (const member of activeMembers) {
    if (!member.reportRequired) continue;

    const declared = declaredByMemberId.get(member.memberId);
    if (declared && (ABSENCE_KINDS as readonly string[]).includes(declared.kind)) {
      expectations.set(member.memberId, { expected: false, reason: "away", kind: declared.kind, note: declared.note });
      continue;
    }

    // An explicit "masuk" overrides the Saturday default — that is the
    // whole reason the kind exists.
    if (saturday && isSaturdayOptionalFor(member) && declared?.kind !== "masuk") {
      expectations.set(member.memberId, { expected: false, reason: "saturday_off" });
      continue;
    }

    expectations.set(member.memberId, { expected: true });
  }

  return expectations;
}


/** Convenience for callers that only need the yes/no. */
export function isExpected(expectation: AttendanceExpectation | undefined): boolean {
  return expectation?.expected === true;
}

/** The two partial-attendance kinds: present, but late in or leaving early. */
export const PARTIAL_ATTENDANCE_KINDS = ["telat", "pulang_cepat"] as const satisfies readonly AvailabilityKind[];

export interface PartialAttendance {
  kind: "telat" | "pulang_cepat";
  /** The member's own words, which is where the time lives ("datang jam 10"). */
  note: string | null;
}

/**
 * Per-member telat / pulang_cepat for a day, for the date tab's Keterangan
 * column. Deliberately separate from getAttendanceExpectations: these are
 * NOT absences — the member is present and still owes a report, so they
 * must not land in ABSENCE_KINDS and must not exempt anyone. This only
 * surfaces the annotation to show alongside the work.
 *
 * Same "latest uncancelled declaration covering the day wins" rule as
 * everywhere else, and the same fromJakartaWallClock boundary — never
 * hand-rolled offsets.
 */
export async function getPartialAttendance(db: AppDatabase, day: CalendarDay): Promise<Map<string, PartialAttendance>> {
  const declarations = await db
    .select({
      memberId: memberAvailability.memberId,
      kind: memberAvailability.kind,
      note: memberAvailability.note,
      startDate: memberAvailability.startDate,
      endDate: memberAvailability.endDate,
      cancelledAt: memberAvailability.cancelledAt,
      createdAt: memberAvailability.createdAt,
    })
    .from(memberAvailability)
    .orderBy(memberAvailability.createdAt);

  const start = fromJakartaWallClock(day.year, day.month, day.day, 0, 0, 0, 0);
  const latest = new Map<string, PartialAttendance>();
  for (const row of declarations) {
    if (row.cancelledAt) continue;
    if (row.startDate > start) continue;
    if (row.endDate && row.endDate <= start) continue;
    // Ascending createdAt + overwrite: the newest declaration wins. A
    // later non-partial declaration (e.g. the member then took full izin)
    // clears the annotation, matching getAttendanceExpectations.
    if ((PARTIAL_ATTENDANCE_KINDS as readonly string[]).includes(row.kind)) {
      latest.set(row.memberId, { kind: row.kind as PartialAttendance["kind"], note: row.note });
    } else {
      latest.delete(row.memberId);
    }
  }
  return latest;
}
