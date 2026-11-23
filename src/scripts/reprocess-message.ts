import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { incomingMessages } from "../db/schema.ts";
import { resolveMemberByJid } from "../members/service.ts";
import { normalizeIncomingText } from "../messages/normalize.ts";
import { processReportContent } from "../messages/pipeline.ts";

/**
 * Admin recovery — NOT part of the running app, NOT reachable from
 * WhatsApp. Re-runs report extraction for a message that's already
 * durably stored in incoming_messages but never produced a report,
 * because either:
 *   - it predates the header-filter fix (2026-08-07) and was
 *     misclassified as non-report and shelved as context, or
 *   - DeepSeek failed extraction (2026-08-08) and the message was
 *     dropped (pre-fix) or the sender was told to resend (post-fix, but
 *     an admin can recover it directly instead of waiting on that).
 *
 * Deliberately bypasses isAlreadyProcessed()/dedup and the replay check
 * — this is a human deciding to reprocess a specific message, not a live
 * WhatsApp delivery, so neither protection applies or should apply.
 * ARCHITECTURE_PROPOSAL.md's failure-mode matrix always called this out
 * as required ("allow manual reprocessing of specific messages") but it
 * was never built until three real messages needed it on the same day.
 *
 * Usage: node dist/scripts/reprocess-message.js <incoming_messages.message_id>
 */
async function main() {
  const messageId = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmApiKey = process.env.LITELLM_API_KEY;

  if (!messageId) {
    console.error("Usage: node reprocess-message.js <incoming_messages.message_id>");
    process.exit(1);
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!litellmBaseUrl) throw new Error("LITELLM_BASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const [row] = await db.select().from(incomingMessages).where(eq(incomingMessages.messageId, messageId)).limit(1);
  if (!row) {
    console.error(`NOT_FOUND: no incoming_messages row for ${messageId}`);
    process.exit(1);
  }
  if (!row.rawText) {
    console.error(`NO_TEXT: raw_text is null for ${messageId} (redacted by retention cleanup?)`);
    process.exit(1);
  }

  const sender = await resolveMemberByJid(db, row.senderJid);
  if (!sender || sender.membershipStatus !== "active") {
    console.error(`NO_ACTIVE_SENDER: ${row.senderJid} does not resolve to an active member`);
    process.exit(1);
  }

  console.log(
    `REPROCESSING: sender=${sender.preferredName} original_timestamp=${row.messageTimestamp.toISOString()} text_preview=${JSON.stringify(row.rawText.slice(0, 60))}`,
  );

  // Bug found live 2026-08-08: reprocessing with `now = new Date()` (the
  // current moment, not the message's own timestamp) sent a Aug-7 message
  // through reportingDayFor() at Aug-8 wall-clock time — it silently
  // merged into the sender's actual Aug-8 report as a second revision
  // instead of recovering under the correct historical day, and
  // corrupted that report's source_message_id in the process. `now` here
  // MUST be the message's own timestamp so reportingDayFor() resolves to
  // the day the report was actually about, not the day it's being fixed.
  const outcome = await processReportContent(
    db,
    { baseUrl: litellmBaseUrl, ...(litellmApiKey ? { apiKey: litellmApiKey } : {}) },
    sender,
    // raw_text keeps the original, invisible marks included; processing reads the normalized copy.
    normalizeIncomingText(row.rawText),
    row.whatsappMessageKey,
    row.messageTimestamp,
  );

  console.log("OUTCOME:", JSON.stringify(outcome));
  await pool.end();
}

main().catch((error) => {
  console.error("REPROCESS_ERROR:", error);
  process.exit(1);
});
