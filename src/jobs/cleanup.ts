import { and, isNotNull, lt } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { incomingMessages } from "../db/schema.ts";

const DEFAULT_RETENTION_DAYS = 30;

/**
 * SECURITY_AND_PRIVACY.md §8.4 (owner decision, 2026-08-06): raw_text is
 * nulled 30 days after receivedAt — the row, whatsapp_message_key,
 * sender_jid, timestamps, and is_replayed are kept indefinitely for
 * dedup/audit; only the message body is redacted.
 */
export async function redactOldRawMessageText(
  db: AppDatabase,
  now: Date = new Date(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const redacted = await db
    .update(incomingMessages)
    .set({ rawText: null })
    .where(and(lt(incomingMessages.receivedAt, cutoff), isNotNull(incomingMessages.rawText)))
    .returning({ messageId: incomingMessages.messageId });
  return redacted.length;
}
