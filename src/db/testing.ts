import { PGlite } from "@electric-sql/pglite";
import { afterEach } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema.ts";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Every instance handed out since the current test started. PGlite is a
 * whole PostgreSQL compiled to WASM, so each one holds real memory until
 * it is closed — and until 2026-08-29 nothing ever closed them, across
 * 171 createTestDb() calls.
 */
const liveInstances: PGlite[] = [];

// Registered at module scope, so importing this module is enough — no
// change at any call site, and no test can forget to clean up. Node scopes
// a top-level afterEach to that file's root suite, and each file is its
// own process, so this only ever closes its own instances.
afterEach(async () => {
  const closing = liveInstances.splice(0);
  await Promise.all(closing.map((client) => client.close().catch(() => {})));
});

/**
 * The schema DDL, read from the committed migrations in drizzle/.
 *
 * It used to be generated at runtime by drizzle-kit's generateMigration().
 * That was the last source of the suite flakiness — roughly 1 run in 6-8
 * died with a whole file failing and no named test. The error was finally
 * captured 2026-09-01 and was not about PGlite at all:
 *
 *   node_modules/drizzle-kit/api.mjs:33897
 *                 if (c5 === boundary[index6 + 2U) {
 *   SyntaxError: Invalid or unexpected token
 *
 * `boundary[index6 + 2])` read back as `boundary[index6 + 2U)` — a corrupt
 * read of drizzle-kit's ~34k-line api.mjs, which every worker process
 * imported, eight at a time, on Windows. It failed during module load,
 * before a single test ran, which is exactly why it always surfaced as a
 * nameless file-level failure in a different file each time: what varied
 * was which worker got the bad read, not which test was wrong.
 *
 * Reading .sql text keeps drizzle-kit out of the test runtime entirely.
 * The one place it still loads is migrations.test.ts, which exists to
 * prove these files still match schema.ts — a single process, and the
 * check that stops this from silently drifting into testing against a
 * stale schema.
 */
let cachedDdl: string | null = null;
let cachedSchemaSnapshot: Promise<Blob> | undefined;
function schemaDdl(): string {
  if (cachedDdl !== null) return cachedDdl;

  const dir = join(import.meta.dirname, "..", "..", "drizzle");
  // Lexical order is chronological here (0000_, 0001_, ...) and must be:
  // a migration applied out of order would ALTER a table before it exists.
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);

  // statement-breakpoint is drizzle-kit's own marker, not SQL. PGlite's
  // exec() takes the whole script in one call, so the statements only need
  // separating by semicolons, which they already are.
  cachedDdl = files
    .map((name) => readFileSync(join(dir, name), "utf-8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
  return cachedDdl;
}

function schemaSnapshot(): Promise<Blob> {
  if (!cachedSchemaSnapshot) {
    // Cache one migrated, empty data directory; each test still gets its own PGlite instance.
    cachedSchemaSnapshot = (async () => {
      const template = new PGlite();
      try {
        await template.waitReady;
        await template.exec(schemaDdl());
        return await template.dumpDataDir("none");
      } finally {
        await template.close();
      }
    })();
  }
  return cachedSchemaSnapshot;
}

/**
 * In-memory PostgreSQL (via PGlite/WASM) with the real schema applied — no
 * Docker/network dependency, so service unit tests exercise real SQL
 * (constraints, defaults, enums) instead of a hand-rolled mock.
 *
 * Released automatically when the calling test ends; see liveInstances.
 */
export async function createTestDb(): Promise<TestDb> {
  const snapshot = await schemaSnapshot();
  const client = new PGlite({ loadDataDir: snapshot });
  liveInstances.push(client);
  await client.waitReady;
  const db = drizzle(client, { schema });
  return db;
}
