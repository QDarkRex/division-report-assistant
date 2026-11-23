import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Applies pending SQL migrations from ./drizzle (generated via
 * `npm run db:generate`) to the configured database. Run this on deploy,
 * before starting the app — not automatically on every app boot, so a
 * migration failure is a visible deploy-time failure, not a silent runtime
 * retry loop.
 *
 * Reads DATABASE_URL directly rather than via config/env.ts's loadConfig()
 * — that schema also requires WHATSAPP_GROUP_JID (needed for the app to
 * boot), which has nothing to do with running a migration and would make
 * `npm run db:migrate` fail on an unrelated missing env var. Found
 * 2026-08-07 while writing an unrelated one-off script that also only
 * needs the database.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
