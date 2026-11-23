import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, setMembershipStatus } from "./service.ts";
import {
  cancelAvailability,
  countLeaveDaysInRange,
  getActiveAvailability,
  getAvailabilityKindsForDay,
  listMembersOnLeave,
  setAvailability,
} from "./availability.ts";

const DAY = { year: 2026, month: 8, day: 10 };

test("a member with a declared izin is active on that day", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "izin", DAY);

  const active = await getActiveAvailability(db, member.memberId, DAY);
  assert.equal(active?.kind, "izin");
});

test("a declaration for one day does not cover the next day", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "sakit", DAY);

  const nextDay = { ...DAY, day: DAY.day + 1 };
  const active = await getActiveAvailability(db, member.memberId, nextDay);
  assert.equal(active, null);
});

test("a member with no declaration has no active availability", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  const active = await getActiveAvailability(db, member.memberId, DAY);
  assert.equal(active, null);
});

test("a later declaration for the same day wins over an earlier one", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "izin", DAY);
  await setAvailability(db, member.memberId, "cuti", DAY);

  const active = await getActiveAvailability(db, member.memberId, DAY);
  assert.equal(active?.kind, "cuti");
});

test("listMembersOnLeave returns only active members with a declaration covering the day", async () => {
  const db = await createTestDb();
  const onLeave = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, onLeave.memberId, "active");
  await setAvailability(db, onLeave.memberId, "cuti", DAY);

  const notOnLeave = await createMember(db, { preferredName: "Ani" });
  await setMembershipStatus(db, notOnLeave.memberId, "active");

  const inactiveOnLeave = await createMember(db, { preferredName: "Rina" });
  await setAvailability(db, inactiveOnLeave.memberId, "sakit", DAY); // stays "pending", not active

  const list = await listMembersOnLeave(db, DAY);
  assert.deepEqual(
    list.map((m) => m.memberId),
    [onLeave.memberId],
  );
});

// §14: "The status applies immediately but an admin can correct or cancel it."
test("cancelling a declaration removes it from the active lookup", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "izin", DAY);

  const cancelled = await cancelAvailability(db, member.memberId, DAY, member.memberId);
  assert.equal(cancelled, 1);
  assert.equal(await getActiveAvailability(db, member.memberId, DAY), null);
});

test("cancelling soft-deletes — the retracted row is kept, not erased", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "izin", DAY);
  await cancelAvailability(db, member.memberId, DAY, member.memberId);

  const { memberAvailability } = await import("../db/schema.ts");
  const rows = await db.select().from(memberAvailability);
  assert.equal(rows.length, 1, "the declaration and its retraction are both part of the record");
  assert.ok(rows[0]?.cancelledAt, "cancelledAt must be stamped");
  assert.equal(rows[0]?.cancelledByMemberId, member.memberId);
});

test("cancelling when nothing was declared reports zero, so the caller can say so", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  assert.equal(await cancelAvailability(db, member.memberId, DAY, member.memberId), 0);
});

test("a cancelled member no longer appears in listMembersOnLeave", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, member.memberId, "active");
  await setAvailability(db, member.memberId, "cuti", DAY);
  await cancelAvailability(db, member.memberId, DAY, member.memberId);

  assert.deepEqual(await listMembersOnLeave(db, DAY), []);
});

// Owner request 2026-08-12: the Sheets date tab writes the kind itself.
test("getAvailabilityKindsForDay returns the kind per member, latest declaration winning", async () => {
  const db = await createTestDb();
  const budi = await createMember(db, { preferredName: "Budi" });
  const ani = await createMember(db, { preferredName: "Ani" });
  await setAvailability(db, budi.memberId, "izin", DAY);
  await setAvailability(db, budi.memberId, "cuti", DAY); // correction: later wins
  await setAvailability(db, ani.memberId, "sakit", DAY);

  const kinds = await getAvailabilityKindsForDay(db, DAY);
  assert.equal(kinds.get(budi.memberId), "cuti", "must agree with getActiveAvailability's latest-wins rule");
  assert.equal(kinds.get(ani.memberId), "sakit");
});

test("getAvailabilityKindsForDay omits cancelled declarations", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "izin", DAY);
  await cancelAvailability(db, member.memberId, DAY, member.memberId);

  assert.equal((await getAvailabilityKindsForDay(db, DAY)).size, 0);
});

test("countLeaveDaysInRange counts only days actually covered", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 10 });
  await setAvailability(db, member.memberId, "cuti", { year: 2026, month: 8, day: 12 });

  const count = await countLeaveDaysInRange(db, member.memberId, { year: 2026, month: 8, day: 10 }, { year: 2026, month: 8, day: 15 });
  assert.equal(count, 2, "two declared days inside the range, the rest uncovered");
});
