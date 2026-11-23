import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember, relinkWhatsappJid, setMembershipStatus } from "./service.ts";
import { buildMentionMessage, mentionToken, REPORT_REMINDER_LEAD, resolveMentionables } from "./mentions.ts";

test("a mention token is the JID's local part, which is a LID in this group", () => {
  assert.equal(mentionToken("10000000000016@lid"), "@10000000000016");
  assert.equal(mentionToken("628111@s.whatsapp.net"), "@628111");
});

test("resolveMentionables returns only members with a current identifier", async () => {
  const db = await createTestDb();
  const withJid = await createMember(db, { preferredName: "Agas" });
  await setMembershipStatus(db, withJid.memberId, "active");
  await relinkWhatsappJid(db, withJid.memberId, "111@lid");
  const withoutJid = await createMember(db, { preferredName: "Budi" });
  await setMembershipStatus(db, withoutJid.memberId, "active");

  const resolved = await resolveMentionables(db, [withJid, withoutJid]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.jid, "111@lid");
});

// Being un-pingable is not the same as being excused. A reminder that
// quietly drops someone because their identifier row is missing reads as
// "you were not expected to report" — which is exactly the kind of silent
// omission this system has been bitten by repeatedly.
test("a member with no identifier is still named, just without a tag", async () => {
  const db = await createTestDb();
  const agas = await createMember(db, { preferredName: "Agas" });
  await relinkWhatsappJid(db, agas.memberId, "111@lid");
  const budi = await createMember(db, { preferredName: "Budi" });

  const mentionables = await resolveMentionables(db, [agas, budi]);
  const message = buildMentionMessage(REPORT_REMINDER_LEAD, [agas, budi], mentionables);

  assert.match(message.text, /@111/);
  assert.match(message.text, /tanpa tag: Budi/);
  assert.deepEqual(message.mentionedJids, ["111@lid"]);
});

test("every mentioned JID appears both in the text and in the mentions array", async () => {
  const db = await createTestDb();
  const agas = await createMember(db, { preferredName: "Agas" });
  await relinkWhatsappJid(db, agas.memberId, "111@lid");
  const budi = await createMember(db, { preferredName: "Budi" });
  await relinkWhatsappJid(db, budi.memberId, "222@lid");

  const mentionables = await resolveMentionables(db, [agas, budi]);
  const message = buildMentionMessage(REPORT_REMINDER_LEAD, [agas, budi], mentionables);

  // Both halves are required: the text alone notifies nobody, the array
  // alone highlights nothing.
  for (const jid of message.mentionedJids) {
    assert.match(message.text, new RegExp(mentionToken(jid)));
  }
  assert.equal(message.mentionedJids.length, 2);
  assert.doesNotMatch(message.text, /tanpa tag/);
});

test("nobody to mention produces no mention array, and no stray parenthetical", async () => {
  const db = await createTestDb();
  const message = buildMentionMessage(REPORT_REMINDER_LEAD, [], []);
  assert.equal(message.mentionedJids.length, 0);
  assert.equal(message.text, REPORT_REMINDER_LEAD);
});

test("the reminder reads as a title line, then the tags, then anyone who cannot be tagged", async () => {
  const db = await createTestDb();
  const agas = await createMember(db, { preferredName: "Agas" });
  await relinkWhatsappJid(db, agas.memberId, "111@lid");
  const budi = await createMember(db, { preferredName: "Budi" });
  await relinkWhatsappJid(db, budi.memberId, "222@lid");
  const siti = await createMember(db, { preferredName: "Siti" });

  const mentionables = await resolveMentionables(db, [agas, budi, siti]);
  const message = buildMentionMessage(REPORT_REMINDER_LEAD, [agas, budi, siti], mentionables);

  assert.equal(message.text, "⏰ *Belum lapor hari ini*\n@111 @222\n(tanpa tag: Siti)");
});
