import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { members } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";
import { setAvailability } from "../members/availability.ts";
import { addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { calendarDayOf, fromJakartaWallClock } from "../shared/time.ts";
import { listMissingReporters } from "./report-reminders.ts";

test("a member who has not reported today appears in the missing list", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0); // 20:00 WIB reminder time
  const missing = await listMissingReporters(db, now);
  assert.deepEqual(
    missing.map((m) => m.memberId),
    [member.memberId],
  );
});

test("a member who already reported today is not missing", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0);
  const report = await getOrCreateDailyReport(db, member.memberId, "2026-08-07");
  await addRevision(db, report.reportId, "report\n- cek panel");

  const missing = await listMissingReporters(db, now);
  assert.deepEqual(missing, []);
});

test("an inactive member is never in the missing list", async () => {
  const db = await createTestDb();
  await createMember(db, { preferredName: "Agas" });
  // left at membershipStatus "pending" — never activated

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0);
  const missing = await listMissingReporters(db, now);
  assert.deepEqual(missing, []);
});

test("a member with report_required=false is never in the missing list", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas", reportRequired: false });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0);
  const missing = await listMissingReporters(db, now);
  assert.deepEqual(missing, []);
});

// d3 (attendance/leave)
test("a member on declared leave for today is not in the missing list", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0);
  await setAvailability(db, member.memberId, "sakit", calendarDayOf(now));

  const missing = await listMissingReporters(db, now);
  assert.deepEqual(missing, []);
});

test("leave declared for a different day does not exempt today's report", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  const now = fromJakartaWallClock(2026, 8, 7, 20, 0);
  await setAvailability(db, member.memberId, "sakit", { year: 2026, month: 8, day: 6 });

  const missing = await listMissingReporters(db, now);
  assert.deepEqual(
    missing.map((m) => m.memberId),
    [member.memberId],
  );
});

// Fixed 2026-08-12: the leave lookup used the calendar day while the report
// lookup used the reporting day. They diverge between 00:00 and 09:59, so
// "@helper siapa yang belum lapor?" asked at 08:00 compared yesterday's
// reports against today's leave — a member on leave yesterday was named as
// not having reported.
test("at 08:00 the leave check uses the same reporting day as the report check, not the calendar day", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  // On leave for reporting day Aug 11.
  await setAvailability(db, member.memberId, "sakit", { year: 2026, month: 8, day: 11 });

  // 08:00 on Aug 12: reporting day is still Aug 11 (window closes 09:59).
  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 12, 8, 0));
  assert.deepEqual(missing, [], "leave declared for Aug 11 must still cover Aug 11's reporting day at 08:00 on Aug 12");
});

test("at 08:00, leave declared for the new calendar day does not excuse the still-open previous reporting day", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");

  // On leave for Aug 12 only — says nothing about Aug 11, which is the
  // reporting day still open at 08:00 on Aug 12.
  await setAvailability(db, member.memberId, "sakit", { year: 2026, month: 8, day: 12 });

  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 12, 8, 0));
  assert.deepEqual(
    missing.map((m) => m.memberId),
    [member.memberId],
  );
});

// Owner 2026-08-29: outside magang, Saturday is not required — so they
// must not be nagged for it either. Same shared rule the date tab uses.
test("on Saturday, senior and staff are not chased for a report", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  // 2026-08-29 is a Saturday; 20:00 is the first reminder slot.
  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 29, 20, 0));
  assert.deepEqual(missing, []);
});

test("on Saturday, magang are still chased", async () => {
  const db = await createTestDb();
  const magang = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, magang.memberId, "active");

  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 29, 20, 0));
  assert.deepEqual(missing.map((m) => m.preferredName), ["Budi"]);
});

test("a non-magang who declared 'masuk' on Saturday IS chased", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));
  await setAvailability(db, senior.memberId, "masuk", { year: 2026, month: 8, day: 29 });

  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 29, 20, 0));
  assert.deepEqual(missing.map((m) => m.preferredName), ["Affan"]);
});

test("on a weekday a senior is chased normally", async () => {
  const db = await createTestDb();
  const senior = await createMember(db, { preferredName: "Affan" });
  await setMembershipStatus(db, senior.memberId, "active");
  await db.update(members).set({ level: "senior" }).where(eq(members.memberId, senior.memberId));

  const missing = await listMissingReporters(db, fromJakartaWallClock(2026, 8, 28, 20, 0));
  assert.deepEqual(missing.map((m) => m.preferredName), ["Affan"]);
});
