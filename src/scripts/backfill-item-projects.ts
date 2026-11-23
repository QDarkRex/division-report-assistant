import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { reportItems } from "../db/schema.ts";
import { loadProjectTerms, matchProjectInText } from "../projects/matching.ts";

/**
 * One-off — attaches historical report items to the projects created on
 * 2026-08-31. Owner's instruction: link the ones I am confident about,
 * bring the rest back as questions.
 *
 * "Confident" is defined narrowly and mechanically: the item's text names
 * exactly ONE project by name or alias. Anything matching two projects is
 * left NULL, because the owner confirmed that "lifter" and "antenna
 * tracker" each exist in both the Alpha and Beta dockings — and was
 * unsure about the second themselves. Anything matching none is left NULL
 * too; roughly half the items describe work in terms that name no project
 * at all ("Wiring Latte panda", "Melanjutkan pembuatan PCB").
 *
 * Only fills rows where project_id IS NULL, so re-running never overwrites
 * an attribution a human has since corrected by hand in the sheet.
 *
 * Dry run by default. Pass --apply to write.
 *
 * Usage: node dist/scripts/backfill-item-projects.js [--apply]
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const allTerms = await loadProjectTerms(db);
  const items = await db.select().from(reportItems).where(isNull(reportItems.projectId));

  const perProject = new Map<string, number>();
  let linked = 0;

  for (const item of items) {
    const haystack = `${item.activity} ${item.result ?? ""} ${item.obstacle ?? ""}`;
    const match = matchProjectInText(haystack, allTerms);
    if (!match) continue;

    linked++;
    perProject.set(match.name, (perProject.get(match.name) ?? 0) + 1);
    if (apply) {
      await db.update(reportItems).set({ projectId: match.projectId }).where(eq(reportItems.itemId, item.itemId));
    }
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${items.length} item belum bertaut project`);
  console.log(`  ditautkan   : ${linked}`);
  console.log(`  dibiarkan   : ${items.length - linked}  (tidak jelas atau menyebut >1 project)\n`);
  for (const [name, n] of [...perProject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error("BACKFILL_ITEM_PROJECTS_ERROR:", error);
  process.exit(1);
});
