import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { incomingMessages, processedMessageKeys } from "../db/schema.ts";
import { isReplayedMessage } from "./replay.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";

export type IncomingMessageRow = typeof incomingMessages.$inferSelect;

/** §18: idempotent message processing — checked before any other work happens. */
export async function isAlreadyProcessed(db: AppDatabase, whatsappMessageKey: string): Promise<boolean> {
  const [row] = await db
    .select({ key: processedMessageKeys.whatsappMessageKey })
    .from(processedMessageKeys)
    .where(eq(processedMessageKeys.whatsappMessageKey, whatsappMessageKey))
    .limit(1);
  return row !== undefined;
}

export async function markProcessed(db: AppDatabase, whatsappMessageKey: string): Promise<void> {
  await db.insert(processedMessageKeys).values({ whatsappMessageKey }).onConflictDoNothing();
}

/** Stores the raw message and computes is_replayed via ./replay.ts — always runs, even for a message the pipeline will otherwise ignore, so the audit/dedup trail is complete. */
export async function recordIncomingMessage(
  db: AppDatabase,
  input: { whatsappMessageKey: string; senderJid: string; rawText: string; messageTimestamp: Date; receivedAt?: Date },
): Promise<IncomingMessageRow> {
  const receivedAt = input.receivedAt ?? new Date();
  const [row] = await db
    .insert(incomingMessages)
    .values({
      whatsappMessageKey: input.whatsappMessageKey,
      senderJid: input.senderJid,
      rawText: input.rawText,
      messageTimestamp: input.messageTimestamp,
      receivedAt,
      isReplayed: isReplayedMessage(input.messageTimestamp, receivedAt),
    })
    // Idempotent since 2026-09-08, when the pipeline stopped marking a
    // message processed before it had finished with it. A failed attempt
    // now leaves the message retryable, so the SAME whatsapp_message_key
    // legitimately arrives here twice — and a plain insert made that
    // second attempt die on the unique index instead of recovering. The
    // stored copy is the first one deliberately: raw_text is what the
    // member actually sent, and a redelivery must never rewrite it.
    .onConflictDoNothing({ target: incomingMessages.whatsappMessageKey })
    .returning();
  if (row) return row;

  const [existing] = await db
    .select()
    .from(incomingMessages)
    .where(eq(incomingMessages.whatsappMessageKey, input.whatsappMessageKey))
    .limit(1);
  if (!existing) throw new Error("incoming message insert returned no row and no existing row was found");
  return existing;
}

export function toIncomingMessageInput(message: IncomingMessage) {
  return {
    whatsappMessageKey: message.messageId,
    senderJid: message.senderJid,
    rawText: message.text,
    messageTimestamp: message.messageTimestamp,
    receivedAt: message.receivedAt,
  };
}
