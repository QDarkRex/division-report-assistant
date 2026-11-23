import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { addAlias, createMember, relinkWhatsappJid } from "../members/service.ts";
import { addProjectAlias, createProject } from "../projects/service.ts";
import {
  buildMentionDictionary,
  buildRestoreDictionary,
  redactForLlm,
  redactKnownEntities,
  redactMentions,
  redactStructuredIdentifiers,
  restoreEntities,
} from "./redaction.ts";

// ACCEPTANCE_TESTS.md §5.2
test("phone numbers are replaced before LLM call", () => {
  const result = redactStructuredIdentifiers("Nomor saya 081234567890 ya");
  assert.equal(result.text, "Nomor saya [PHONE_REDACTED] ya");
  assert.equal(result.phoneCount, 1);
});

test("JIDs are replaced before LLM call", () => {
  const result = redactStructuredIdentifiers("Sender: 6281234567890@s.whatsapp.net");
  assert.equal(result.text, "Sender: [JID_REDACTED]");
  assert.equal(result.jidCount, 1);
});

test("JID digits are not double-counted as a phone number", () => {
  const result = redactStructuredIdentifiers("6281234567890@s.whatsapp.net");
  assert.equal(result.phoneCount, 0);
  assert.equal(result.jidCount, 1);
});

test("text with no identifiers passes through unchanged", () => {
  const result = redactStructuredIdentifiers("test docking charge berhasil");
  assert.equal(result.text, "test docking charge berhasil");
  assert.equal(result.phoneCount, 0);
  assert.equal(result.jidCount, 0);
});

test("known entity dictionary redacts registered member and project names, case-insensitively", () => {
  const result = redactKnownEntities("Budi mengerjakan Panel Upgrade hari ini", [
    { pattern: "budi", replacement: "[MEMBER:m1]" },
    { pattern: "Panel Upgrade", replacement: "[PROJECT:p1]" },
  ]);
  assert.equal(result.text, "[MEMBER:m1] mengerjakan [PROJECT:p1] hari ini");
  assert.equal(result.matchCount, 2);
});

test("longer names match before shorter overlapping aliases", () => {
  const result = redactKnownEntities("Budi Santoso sudah selesai", [
    { pattern: "Budi", replacement: "[MEMBER:short]" },
    { pattern: "Budi Santoso", replacement: "[MEMBER:full]" },
  ]);
  assert.equal(result.text, "[MEMBER:full] sudah selesai");
});

test("unregistered names are left untouched — explicit scope limit, not a bug", () => {
  const result = redactKnownEntities("Pak Joko dari klien menelpon", [{ pattern: "Agas", replacement: "[MEMBER:m1]" }]);
  assert.equal(result.text, "Pak Joko dari klien menelpon");
  assert.equal(result.matchCount, 0);
});

// Full pipeline, DB-backed dictionary from real members/projects
test("redactForLlm combines structured and dictionary redaction using live members/projects", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Agas" });
  await addAlias(db, member.memberId, "Mas Agas");
  const project = await createProject(db, { name: "Panel Upgrade" });
  await addProjectAlias(db, project.projectId, "gardu induk");

  const result = await redactForLlm(
    db,
    "report Mas Agas\n- pekerjaan: cek gardu induk, hubungi 081234567890, sender 6281234567890@s.whatsapp.net",
  );

  assert.ok(!result.text.includes("081234567890"));
  assert.ok(!result.text.includes("6281234567890@s.whatsapp.net"));
  assert.ok(result.text.includes(`[MEMBER:${member.memberId}]`));
  assert.ok(result.text.includes(`[PROJECT:${project.projectId}]`));
  assert.equal(result.redactedPhoneCount, 1);
  assert.equal(result.redactedJidCount, 1);
  assert.equal(result.redactedEntityCount, 2);
});

// Found live 2026-08-29 in a real report: "...UI nextion buatan
// @10000000000004". JID_PATTERN needs an @domain suffix, so a mention —
// which is just "@" plus the bare number — slipped past every pass and
// went to the cloud LLM intact, against §4.2's rule on stripping JIDs.
test("an @-mention of a known member becomes the same token a typed name would", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Arief" });
  await relinkWhatsappJid(db, member.memberId, "10000000000004@lid");

  const dictionary = await buildMentionDictionary(db);
  const result = redactMentions("testing meja dengan UI nextion buatan @10000000000004", dictionary);

  assert.equal(result.text, `testing meja dengan UI nextion buatan [MEMBER:${member.memberId}]`);
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.unresolvedCount, 0);
});

test("a mention of an unknown number is still removed — an unknown identifier is an identifier", async () => {
  const db = await createTestDb();
  const dictionary = await buildMentionDictionary(db);
  const result = redactMentions("bareng @99887766554433 kemarin", dictionary);

  assert.equal(result.text, "bareng [MENTION_REDACTED] kemarin");
  assert.equal(result.unresolvedCount, 1);
  assert.doesNotMatch(result.text, /99887766554433/, "the raw number must never survive to the LLM");
});

test("a mention of a member's PREVIOUS number still identifies them", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Arief" });
  await relinkWhatsappJid(db, member.memberId, "111111111111@lid");
  await relinkWhatsappJid(db, member.memberId, "222222222222@lid");

  const dictionary = await buildMentionDictionary(db);
  assert.equal(redactMentions("@111111111111", dictionary).resolvedCount, 1, "historical identifiers resolve too");
  assert.equal(redactMentions("@222222222222", dictionary).resolvedCount, 1);
});

test("ordinary text with no mention is untouched", async () => {
  const db = await createTestDb();
  const dictionary = await buildMentionDictionary(db);
  assert.equal(redactMentions("wiring panel B selesai", dictionary).text, "wiring panel B selesai");
});

// Redaction was one-way, so tokens the model echoed back were stored
// verbatim: five activities read "Bantuin bang [MEMBER:ff2883ed-...]" in
// the database and in the Sheets date tab.
test("restoreEntities turns member and project tokens back into names", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Arief" });
  const project = await createProject(db, { name: "Drone VEGA" });

  const dictionary = await buildRestoreDictionary(db);
  const restored = restoreEntities(
    `Bantuin bang [MEMBER:${member.memberId}] di [PROJECT:${project.projectId}]`,
    dictionary,
  );
  assert.equal(restored, "Bantuin bang Arief di Drone VEGA");
});

test("an id with no matching row keeps its token rather than leaving a hole in the sentence", async () => {
  const db = await createTestDb();
  const dictionary = await buildRestoreDictionary(db);
  const orphan = "[MEMBER:00000000-0000-0000-0000-000000000000]";
  assert.equal(restoreEntities(`Bantuin bang ${orphan}`, dictionary), `Bantuin bang ${orphan}`);
});

// The round trip is what actually matters: a tagged member must end up
// stored under the same name as a typed one.
test("mention -> redact -> restore yields the member's name, end to end", async () => {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Arief" });
  await relinkWhatsappJid(db, member.memberId, "10000000000004@lid");

  const redacted = await redactForLlm(db, "integrasi program dengan UI nextion buatan @10000000000004");
  assert.doesNotMatch(redacted.text, /10000000000004/, "no identifier reaches the model");
  assert.match(redacted.text, /\[MEMBER:/);

  const restored = restoreEntities(redacted.text, await buildRestoreDictionary(db));
  assert.equal(restored, "integrasi program dengan UI nextion buatan Arief");
});
