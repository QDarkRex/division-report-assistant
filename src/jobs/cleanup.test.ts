import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { incomingMessages } from "../db/schema.ts";
import { redactOldRawMessageText } from "./cleanup.ts";

async function insertMessage(db: Awaited<ReturnType<typeof createTestDb>>, key: string, receivedAt: Date) {
  const [row] = await db
    .insert(incomingMessages)
    .values({ whatsappMessageKey: key, senderJid: "628111@s.whatsapp.net", rawText: "isi laporan rahasia", messageTimestamp: receivedAt, receivedAt })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

test("raw text older than 30 days is nulled, the row and key survive", async () => {
  const db = await createTestDb();
  const now = new Date("2026-08-07T00:00:00.000Z");
  const old = await insertMessage(db, "wa-old", new Date("2026-07-01T00:00:00.000Z"));

  const count = await redactOldRawMessageText(db, now);
  assert.equal(count, 1);

  const [stored] = await db.select().from(incomingMessages).where(eq(incomingMessages.messageId, old.messageId));
  assert.equal(stored?.rawText, null);
  assert.equal(stored?.whatsappMessageKey, "wa-old");
});

test("raw text within the retention window is left alone", async () => {
  const db = await createTestDb();
  const now = new Date("2026-08-07T00:00:00.000Z");
  const recent = await insertMessage(db, "wa-recent", new Date("2026-08-01T00:00:00.000Z"));

  const count = await redactOldRawMessageText(db, now);
  assert.equal(count, 0);

  const [stored] = await db.select().from(incomingMessages).where(eq(incomingMessages.messageId, recent.messageId));
  assert.equal(stored?.rawText, "isi laporan rahasia");
});

test("a message already redacted is not counted again", async () => {
  const db = await createTestDb();
  const now = new Date("2026-08-07T00:00:00.000Z");
  await insertMessage(db, "wa-old", new Date("2026-07-01T00:00:00.000Z"));

  const first = await redactOldRawMessageText(db, now);
  const second = await redactOldRawMessageText(db, now);
  assert.equal(first, 1);
  assert.equal(second, 0);
});
