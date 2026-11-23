import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import {
  createMember,
  getMember,
  listActiveMembers,
  relinkWhatsappJid,
  renamePreferredName,
  resolveMemberByJid,
  resolveMembersByNameOrAlias,
  setMembershipStatus,
} from "./service.ts";

// ACCEPTANCE_TESTS.md §1.1
test("two members with the same display name have separate profiles", async () => {
  const db = await createTestDb();
  const a = await createMember(db, { preferredName: "Agas" });
  const b = await createMember(db, { preferredName: "Agas" });
  assert.notEqual(a.memberId, b.memberId);
});

test("display name change does not lose profile history — old name becomes alias", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi" });
  await renamePreferredName(db, member.memberId, "Budi Santoso");

  const updated = await getMember(db, member.memberId);
  assert.equal(updated?.preferredName, "Budi Santoso");

  const matches = await resolveMembersByNameOrAlias(db, "Budi");
  assert.deepEqual(
    matches.map((m) => m.memberId),
    [member.memberId],
  );
});

test("typing a name that matches a member resolves to that member", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  const matches = await resolveMembersByNameOrAlias(db, "agas");
  assert.deepEqual(
    matches.map((m) => m.memberId),
    [member.memberId],
  );
});

test("typing a name that matches no member returns empty", async () => {
  const db = await createTestDb();
  await createMember(db, { preferredName: "Agas" });
  const matches = await resolveMembersByNameOrAlias(db, "Someone Else");
  assert.deepEqual(matches, []);
});

test("phone number change retains the same member_id — old JID deactivated, new JID linked", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Budi", whatsappJid: "628111@s.whatsapp.net" });

  const beforeChange = await resolveMemberByJid(db, "628111@s.whatsapp.net");
  assert.equal(beforeChange?.memberId, member.memberId);

  await relinkWhatsappJid(db, member.memberId, "628222@s.whatsapp.net");

  const oldJidLookup = await resolveMemberByJid(db, "628111@s.whatsapp.net");
  assert.equal(oldJidLookup, null);

  const newJidLookup = await resolveMemberByJid(db, "628222@s.whatsapp.net");
  assert.equal(newJidLookup?.memberId, member.memberId);
});

// Chief-review finding: Indonesian prepaid numbers get recycled — a JID
// must be unique only among *current* links, not globally across history.
test("a deactivated JID can be re-linked to a different member (number recycling)", async () => {
  const db = await createTestDb();
  const oldOwner = await createMember(db, { preferredName: "Old Owner", whatsappJid: "628999@s.whatsapp.net" });
  await relinkWhatsappJid(db, oldOwner.memberId, "628111@s.whatsapp.net");

  const newOwner = await createMember(db, { preferredName: "New Owner", whatsappJid: "628999@s.whatsapp.net" });

  const resolved = await resolveMemberByJid(db, "628999@s.whatsapp.net");
  assert.equal(resolved?.memberId, newOwner.memberId);
});

// ACCEPTANCE_TESTS.md §1.2 (lifecycle side, permission side is covered in permissions/engine.test.ts)
test("inactive member is excluded from the active member list; reactivation restores it with history intact", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, member.memberId, "active");
  assert.equal((await listActiveMembers(db)).length, 1);

  await setMembershipStatus(db, member.memberId, "inactive");
  assert.equal((await listActiveMembers(db)).length, 0);

  await setMembershipStatus(db, member.memberId, "active");
  const reactivated = await getMember(db, member.memberId);
  assert.equal(reactivated?.memberId, member.memberId);
  assert.equal(reactivated?.preferredName, "Agas");
});
