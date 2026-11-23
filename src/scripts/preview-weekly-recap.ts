import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { composeWeeklyRecap, persistRefusal, persistWeeklyRecap, recapWeekStartFor } from "../recap/weekly.ts";

/**
 * Prints the weekly recap as it would be sent, without sending it.
 *
 * Without --llm only the deterministic fallback is rendered (no call). With
 * --llm it makes the same ONE call the Sunday job would — a REAL call, recorded
 * in llm_invocations and counted against the monthly budget. With --persist it
 * also stores the assignments (report_items.work_stream_id), new streams, the
 * REKAP MINGGUAN rows and the message — used to backfill previous weeks before
 * the first live send (oldest week first: "pekan lalu" and "tanpa laporan" read
 * the assignments of the two weeks before).
 *
 * Env: DATABASE_URL (required); for --llm also LITELLM_BASE_URL (default
 * http://gateway:4000), LITELLM_API_KEY (optional) and WDH_LLM_MODEL
 * (default deepseek-v4-flash), as in the app.
 *
 * Usage: node dist/scripts/preview-weekly-recap.js [--week=YYYY-MM-DD] [--llm] [--persist]
 *   --week  any date inside the wanted week (default: the week containing now)
 */
async function main() {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const persist = args.includes("--persist");
  if (persist && !useLlm) throw new Error("--persist needs --llm: without the model there are no assignments to store");
  const weekArg = args.find((a) => a.startsWith("--week="))?.slice("--week=".length);
  const now = new Date();
  let anchor = now;
  if (weekArg) {
    anchor = new Date(`${weekArg}T12:00:00+07:00`);
    if (Number.isNaN(anchor.getTime())) throw new Error(`bad --week value "${weekArg}"`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    const recap = await composeWeeklyRecap(
      db,
      useLlm
        ? {
            llm: {
              llm: {
                baseUrl: process.env.LITELLM_BASE_URL ?? "http://gateway:4000",
                ...(process.env.LITELLM_API_KEY ? { apiKey: process.env.LITELLM_API_KEY } : {}),
              },
              model: process.env.WDH_LLM_MODEL ?? "deepseek-v4-flash",
            },
          }
        : {},
      recapWeekStartFor(anchor),
      now,
    );
    console.log(`--- pekan ${recap.facts.weekStart} · ${recap.facts.itemCount} butir · LLM: ${recap.llmError === null ? "ok" : `tidak dipakai (${recap.llmError})`} · ${recap.text.length} karakter ---`);
    console.log(recap.text);
    const refusal = persist ? persistRefusal(recap) : null;
    if (refusal) {
      console.error(`REFUSED --persist: ${refusal}`);
      process.exitCode = 1;
    } else if (persist) {
      await persistWeeklyRecap(db, recap, null);
      console.log("--- tidak dikirim; DISIMPAN (assignment, aliran baru, REKAP MINGGUAN, pesan) ---");
    } else {
      console.log("--- tidak dikirim, tidak disimpan ---");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("PREVIEW_WEEKLY_RECAP_ERROR:", error);
  process.exit(1);
});
