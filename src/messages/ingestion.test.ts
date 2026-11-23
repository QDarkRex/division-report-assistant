import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { isAlreadyProcessed, markProcessed, recordIncomingMessage } from "./ingestion.ts";

// ACCEPTANCE_TESTS.md §4.1
test("a duplicate WhatsApp event (same message id) is processed once", async () => {
  const db = await createTestDb();
  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), false);
  await markProcessed(db, "wa-msg-1");
  assert.equal(await isAlreadyProcessed(db, "wa-msg-1"), true);
  await assert.doesNotReject(() => markProcessed(db, "wa-msg-1"), "marking twice must not throw");
});

test("recordIncomingMessage stores the raw message and flags a reconnect replay", async () => {
  const db = await createTestDb();
  const messageTimestamp = new Date("2026-08-07T03:00:00.000Z");
  const receivedAt = new Date("2026-08-07T06:00:00.000Z"); // hours later -> replay

  const row = await recordIncomingMessage(db, {
    whatsappMessageKey: "wa-msg-2",
    senderJid: "628111@s.whatsapp.net",
    rawText: "report\n- pekerjaan: cek panel",
    messageTimestamp,
    receivedAt,
  });

  assert.equal(row.isReplayed, true);
  assert.equal(row.rawText, "report\n- pekerjaan: cek panel");
});

test("a live message (received seconds after its own timestamp) is not flagged as replayed", async () => {
  const db = await createTestDb();
  const messageTimestamp = new Date("2026-08-07T03:00:00.000Z");
  const receivedAt = new Date("2026-08-07T03:00:02.000Z");

  const row = await recordIncomingMessage(db, {
    whatsappMessageKey: "wa-msg-3",
    senderJid: "628111@s.whatsapp.net",
    rawText: "report\n- pekerjaan: cek panel",
    messageTimestamp,
    receivedAt,
  });

  assert.equal(row.isReplayed, false);
});
