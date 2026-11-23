import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { composeMorningBrief } from "../brief/morning-brief.ts";

/**
 * Prints the morning brief as it would be sent for "now" (or --now=<ISO>)
 * without sending or storing anything, so a deploy can be checked against the
 * real database before the 08:00 job runs.
 *
 * Without --llm only the facts are rendered. With --llm it makes the same one
 * call the job would — a REAL call: it is recorded in llm_invocations and
 * counts against the monthly budget like the 08:00 one.
 *
 * Env: DATABASE_URL (required); for --llm also LITELLM_BASE_URL (default
 * http://gateway:4000), LITELLM_API_KEY (optional) and WDH_LLM_MODEL
 * (default deepseek-v4-flash), as in the app.
 *
 * Usage: node dist/scripts/preview-morning-brief.js [--llm] [--facts] [--now=2026-10-05T01:00:00Z]
 *   --facts  also print the facts JSON that feed the brief
 */
async function main() {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const showFacts = args.includes("--facts");
  const nowArg = args.find((a) => a.startsWith("--now="))?.slice("--now=".length);
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now value "${nowArg}"`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    const brief = await composeMorningBrief(
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
      now,
    );
    if (showFacts) console.log(JSON.stringify(brief.facts, null, 2), "\n");
    console.log(`--- ${now.toISOString()} · LLM: ${useLlm ? (brief.llm ? "ok" : `tidak dipakai (${brief.llmError ?? "tidak ada isi"})`) : "dimatikan"} · ${brief.text.length} karakter ---`);
    console.log(brief.text);
    console.log("--- tidak dikirim, tidak disimpan ---");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("PREVIEW_MORNING_BRIEF_ERROR:", error);
  process.exit(1);
});
