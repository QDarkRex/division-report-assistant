import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { candidateTasks, reportItems, tasks } from "../db/schema.ts";
import { buildMentionDictionary, buildRestoreDictionary, restoreEntities } from "../llm/redaction.ts";
import { normalizeTitle } from "../tasks/service.ts";

/**
 * Admin recovery — NOT part of the running app. Repairs text written
 * before the 2026-08-29 restore step existed.
 *
 * Two defects, same root: redaction was one-way, so anything the model
 * echoed back kept its token. Stored text reads "Bantuin bang
 * [MEMBER:ff2883ed-...]" in the database and in the Sheets date tab. And
 * an @-mention slipped past redaction entirely, so one activity carries a
 * raw WhatsApp LID that nobody in the division can read as a person.
 *
 * Mentions are resolved the same way live ingestion now does — via
 * member_identifiers, historical rows included — so an old handset still
 * identifies its owner. A mention that resolves to nobody is left ALONE
 * rather than replaced with a placeholder: unlike the live path, nothing
 * here is about to be sent anywhere, and an unreadable number is still
 * better evidence for a human than "[MENTION_REDACTED]".
 *
 * tasks.title carries normalizedTitle, which findTaskByNormalizedTitle
 * matches on — recomputed here, or a repaired task would stop matching
 * the activity that created it.
 *
 * Dry run by default. Pass --apply to write.
 *
 * Usage: node dist/scripts/backfill-redaction-tokens.js [--apply]
 */
const TOKEN_PATTERN = /\[MEMBER:[0-9a-fA-F-]{36}\]|\[PROJECT:[0-9a-fA-F-]{36}\]|@\d{8,20}/;

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const [restoreDictionary, mentionDictionary] = await Promise.all([
    buildRestoreDictionary(db),
    buildMentionDictionary(db),
  ]);

  /**
   * Mentions to names, then tokens to names — the same order live
   * ingestion uses. Written out rather than reusing redactMentions()
   * because the two want opposite things from an UNRESOLVABLE mention:
   * the live path must erase it (it is about to leave the building),
   * while here nothing is being sent anywhere, and an unreadable number
   * is better evidence for a human than a blank.
   */
  function repair(value: string): string {
    const withNames = value.replace(/@(\d{8,20})\b/g, (match, digits: string) => {
      const memberId = mentionDictionary.get(digits);
      return memberId ? `[MEMBER:${memberId}]` : match;
    });
    return restoreEntities(withNames, restoreDictionary);
  }

  let changed = 0;
  let unchanged = 0;

  const itemRows = await db.select().from(reportItems);
  for (const row of itemRows) {
    const nextActivity = TOKEN_PATTERN.test(row.activity) ? repair(row.activity) : row.activity;
    const nextResult = row.result && TOKEN_PATTERN.test(row.result) ? repair(row.result) : row.result;
    const nextObstacle = row.obstacle && TOKEN_PATTERN.test(row.obstacle) ? repair(row.obstacle) : row.obstacle;
    if (nextActivity === row.activity && nextResult === row.result && nextObstacle === row.obstacle) continue;

    if (TOKEN_PATTERN.test(nextActivity)) {
      console.error(`UNRESOLVED report_item ${row.itemId}: ${nextActivity}`);
      unchanged++;
      continue;
    }
    console.log(`report_item: ${row.activity}\n         -> ${nextActivity}`);
    changed++;
    if (apply) {
      await db
        .update(reportItems)
        .set({ activity: nextActivity, result: nextResult, obstacle: nextObstacle })
        .where(eq(reportItems.itemId, row.itemId));
    }
  }

  const taskRows = await db.select().from(tasks);
  for (const row of taskRows) {
    if (!TOKEN_PATTERN.test(row.title)) continue;
    const nextTitle = repair(row.title);
    if (TOKEN_PATTERN.test(nextTitle)) {
      console.error(`UNRESOLVED task ${row.taskId}: ${nextTitle}`);
      unchanged++;
      continue;
    }
    console.log(`task: ${row.title}\n   -> ${nextTitle}`);
    changed++;
    if (apply) {
      await db
        .update(tasks)
        .set({
          title: nextTitle,
          // normalizedTitle drives findTaskByNormalizedTitle; leaving it
          // stale would make the repaired task unmatchable by its own
          // activity.
          normalizedTitle: normalizeTitle(nextTitle),
          // MUST bump version. `tasks` is two-way synced with the Sheets
          // TASKS tab, and the import applies a sheet row whenever its
          // version still matches the database. The first run of this
          // script (2026-08-29) omitted this: the sheet still held the old
          // token-bearing titles at a version that now matched, so the
          // hourly sync 40 minutes later read that as a legitimate admin
          // edit and wrote all five titles straight back. The optimistic
          // lock is exactly what should have caught that, and skipping the
          // increment is what blinded it.
          version: sql`${tasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.taskId, row.taskId));
    }
  }

  const candidateRows = await db.select().from(candidateTasks);
  for (const row of candidateRows) {
    if (!row.suggestedTitle || !TOKEN_PATTERN.test(row.suggestedTitle)) continue;
    const nextTitle = repair(row.suggestedTitle);
    if (TOKEN_PATTERN.test(nextTitle)) {
      console.error(`UNRESOLVED candidate ${row.candidateId}: ${nextTitle}`);
      unchanged++;
      continue;
    }
    console.log(`candidate: ${row.suggestedTitle}\n        -> ${nextTitle}`);
    changed++;
    if (apply) {
      await db.update(candidateTasks).set({ suggestedTitle: nextTitle }).where(eq(candidateTasks.candidateId, row.candidateId));
    }
  }

  console.log(`\n${apply ? "APPLIED" : "DRY RUN"} — changed=${changed} unresolved=${unchanged}`);
  await pool.end();
}

main().catch((error) => {
  console.error("BACKFILL_ERROR:", error);
  process.exit(1);
});
