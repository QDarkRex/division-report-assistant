import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { members } from "../db/schema.ts";
import { createMember, setMembershipStatus } from "./service.ts";
import { setAvailability } from "./availability.ts";
import { getAttendanceExpectations, getPartialAttendance, isSaturday, isSaturdayOptionalFor } from "./attendance.ts";

// 2026-08-29 is a Saturday; 2026-08-28 a Friday.
const SATURDAY = { year: 2026, month: 8, day: 29 };
const FRIDAY = { year: 2026, month: 8, day: 28 };

async function makeMember(db: Awaited<ReturnType<typeof createTestDb>>, name: string, level: "senior" | "staff" | "magang") {
  const member = await createMember(db, { preferredName: name });
  await setMembershipStatus(db, member.memberId, "active");
  await db.update(members).set({ level }).where(eq(members.memberId, member.memberId));
  return member;
}

test("isSaturday uses Jakarta weekdays, not the host timezone", () => {
  assert.equal(isSaturday(SATURDAY), true);
  assert.equal(isSaturday(FRIDAY), false);
});

test("only magang owe Saturday", () => {
  assert.equal(isSaturdayOptionalFor({ level: "senior" }), true);
  assert.equal(isSaturdayOptionalFor({ level: "staff" }), true);
  assert.equal(isSaturdayOptionalFor({ level: "magang" }), false);
});

test("on a weekday everyone is expected regardless of level", async () => {
  const db = await createTestDb();
  const senior = await makeMember(db, "Affan", "senior");
  const magang = await makeMember(db, "Budi", "magang");

  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.get(senior.memberId)?.expected, true);
  assert.equal(expectations.get(magang.memberId)?.expected, true);
});

// Owner 2026-08-29: outside magang, Saturday is not required, and an
// empty row must read "tidak masuk" rather than the reproachful
// "belum lapor".
test("on Saturday, senior and staff are not expected but magang are", async () => {
  const db = await createTestDb();
  const senior = await makeMember(db, "Affan", "senior");
  const staff = await makeMember(db, "Arief", "staff");
  const magang = await makeMember(db, "Budi", "magang");

  const expectations = await getAttendanceExpectations(db, SATURDAY);
  assert.deepEqual(expectations.get(senior.memberId), { expected: false, reason: "saturday_off" });
  assert.deepEqual(expectations.get(staff.memberId), { expected: false, reason: "saturday_off" });
  assert.equal(expectations.get(magang.memberId)?.expected, true);
});

// "...sampai mereka mengirim report atau secara eksplisit bilang masuk"
test("an explicit 'masuk' declaration overrides the Saturday exemption", async () => {
  const db = await createTestDb();
  const senior = await makeMember(db, "Affan", "senior");
  await setAvailability(db, senior.memberId, "masuk", SATURDAY);

  const expectations = await getAttendanceExpectations(db, SATURDAY);
  assert.equal(expectations.get(senior.memberId)?.expected, true, "saying they are coming in makes a report owed again");
});

test("'masuk' is a presence declaration and must never be read as an absence", async () => {
  const db = await createTestDb();
  const magang = await makeMember(db, "Budi", "magang");
  await setAvailability(db, magang.memberId, "masuk", FRIDAY);

  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.get(magang.memberId)?.expected, true, "declaring presence must not excuse them");
});

test("declared leave wins over everything, including on a Saturday a magang would owe", async () => {
  const db = await createTestDb();
  const magang = await makeMember(db, "Budi", "magang");
  await setAvailability(db, magang.memberId, "sakit", SATURDAY);

  const expectations = await getAttendanceExpectations(db, SATURDAY);
  assert.deepEqual(expectations.get(magang.memberId), { expected: false, reason: "away", kind: "sakit", note: null });
});

test("leave is reported with its kind so the sheet can name it", async () => {
  const db = await createTestDb();
  const member = await makeMember(db, "Budi", "magang");
  await setAvailability(db, member.memberId, "cuti", FRIDAY);

  const expectation = await getAttendanceExpectations(db, FRIDAY).then((m) => m.get(member.memberId));
  assert.equal(expectation?.expected, false);
  if (expectation && !expectation.expected && expectation.reason === "away") {
    assert.equal(expectation.kind, "cuti");
  }
});

test("a later declaration for the same day wins, matching getActiveAvailability", async () => {
  const db = await createTestDb();
  const senior = await makeMember(db, "Affan", "senior");
  await setAvailability(db, senior.memberId, "masuk", SATURDAY);
  await setAvailability(db, senior.memberId, "sakit", SATURDAY);

  const expectations = await getAttendanceExpectations(db, SATURDAY);
  assert.deepEqual(expectations.get(senior.memberId), { expected: false, reason: "away", kind: "sakit", note: null });
});

test("members not required to report are absent from the map entirely", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi", reportRequired: false });
  await setMembershipStatus(db, member.memberId, "active");

  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.has(member.memberId), false);
});

test("inactive members are absent from the map entirely", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" }); // stays pending
  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.has(member.memberId), false);
});

test("leave declared for a different day does not leak into this one", async () => {
  const db = await createTestDb();
  const member = await makeMember(db, "Budi", "magang");
  await setAvailability(db, member.memberId, "sakit", { year: 2026, month: 8, day: 27 });

  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.get(member.memberId)?.expected, true);
});

// Owner 2026-08-29: "tolong tambahkan tempat alasan ... tidak wajib tapi
// harus ada tempatnya" — contoh: izin karena bimbingan skripsi, sakit diare.
test("the reason a member gave is carried through to whoever renders it", async () => {
  const db = await createTestDb();
  const member = await makeMember(db, "Budi", "magang");
  await setAvailability(db, member.memberId, "izin", FRIDAY, "bimbingan skripsi");

  const expectation = await getAttendanceExpectations(db, FRIDAY).then((m) => m.get(member.memberId));
  assert.equal(expectation?.expected, false);
  if (expectation && !expectation.expected && expectation.reason === "away") {
    assert.equal(expectation.kind, "izin");
    assert.equal(expectation.note, "bimbingan skripsi");
  }
});

test("no reason given is null, not an empty string — the label must not grow a dangling dash", async () => {
  const db = await createTestDb();
  const member = await makeMember(db, "Budi", "magang");
  await setAvailability(db, member.memberId, "sakit", FRIDAY);

  const expectation = await getAttendanceExpectations(db, FRIDAY).then((m) => m.get(member.memberId));
  if (expectation && !expectation.expected && expectation.reason === "away") {
    assert.equal(expectation.note, null);
  }
});

test("a corrected declaration brings its own reason, not the old one", async () => {
  const db = await createTestDb();
  const member = await makeMember(db, "Budi", "magang");
  await setAvailability(db, member.memberId, "izin", FRIDAY, "bimbingan skripsi");
  await setAvailability(db, member.memberId, "sakit", FRIDAY, "diare");

  const expectation = await getAttendanceExpectations(db, FRIDAY).then((m) => m.get(member.memberId));
  if (expectation && !expectation.expected && expectation.reason === "away") {
    assert.equal(expectation.kind, "sakit");
    assert.equal(expectation.note, "diare", "the stale reason must not survive the correction");
  }
});

// ---------------------------------------------------------------------
// Partial attendance: telat (late) and pulang_cepat (early leave),
// 2026-09-12. Present but not the full day. They must NOT excuse the
// report — a member who came late still owes one — and they surface as an
// annotation, not an absence.
// ---------------------------------------------------------------------

test("telat does not exempt a member from reporting", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  await setAvailability(db, m.memberId, "telat", FRIDAY, "datang jam 10");

  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.get(m.memberId)?.expected, true, "still owes a report");
});

test("getPartialAttendance surfaces telat and pulang_cepat with the member's note", async () => {
  const db = await createTestDb();
  const telatM = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, telatM.memberId, "active");
  await setAvailability(db, telatM.memberId, "telat", FRIDAY, "datang jam 10");
  const earlyM = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, earlyM.memberId, "active");
  await setAvailability(db, earlyM.memberId, "pulang_cepat", FRIDAY, "pulang jam 2");

  const partial = await getPartialAttendance(db, FRIDAY);
  assert.equal(partial.get(telatM.memberId)?.kind, "telat");
  assert.equal(partial.get(telatM.memberId)?.note, "datang jam 10");
  assert.equal(partial.get(earlyM.memberId)?.kind, "pulang_cepat");
});

test("a full-day leave declared after a telat clears the partial annotation", async () => {
  const db = await createTestDb();
  const m = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, m.memberId, "active");
  await setAvailability(db, m.memberId, "telat", FRIDAY, "datang jam 10");
  await setAvailability(db, m.memberId, "sakit", FRIDAY, "demam");

  const partial = await getPartialAttendance(db, FRIDAY);
  assert.equal(partial.has(m.memberId), false, "the later sakit wins, no telat annotation");
  const expectations = await getAttendanceExpectations(db, FRIDAY);
  assert.equal(expectations.get(m.memberId)?.expected, false, "and sakit exempts the report");
});
