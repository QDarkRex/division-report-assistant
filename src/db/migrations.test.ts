import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { createTestDb } from "./testing.ts";
import * as schema from "./schema.ts";
import { members, tasks, pendingActions } from "./schema.ts";

/**
 * Applies the generated SQL files in ./drizzle through drizzle-orm's real
 * migrator — the same files and the same path `npm run db:migrate` uses
 * against the server. src/db/testing.ts also reads those files, but pastes
 * them straight into PGlite; this proves they survive the actual migrator,
 * journal and all.
 */
test("generated migrations in ./drizzle apply cleanly and produce a working schema", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./drizzle" });

  const admin = await db.insert(members).values({ preferredName: "Admin", role: "admin", membershipStatus: "active" }).returning();
  assert.equal(admin.length, 1);

  const [task] = await db
    .insert(tasks)
    .values({ title: "Fix panel", normalizedTitle: "fix panel", createdByMemberId: admin[0]!.memberId })
    .returning();
  assert.ok(task?.taskId);

  // Exercise the partial unique index generated for pending_actions — a
  // second open cancellation proposal on the same task must be rejected,
  // proving the WHERE-clause index actually made it into the SQL file.
  await db.insert(pendingActions).values({ taskId: task!.taskId, actionType: "cancellation", requestedByMemberId: admin[0]!.memberId });
  await assert.rejects(() =>
    db.insert(pendingActions).values({ taskId: task!.taskId, actionType: "cancellation", requestedByMemberId: admin[0]!.memberId }),
  );
});

/**
 * Since 2026-09-01 createTestDb() applies these same migration files
 * instead of generating DDL from schema.ts, so that drizzle-kit is not
 * imported by every worker process (testing.ts explains the corrupt-read
 * failure that caused). That trade introduces a new way to be wrong: edit
 * schema.ts, forget to run `drizzle-kit generate`, and the whole suite
 * would keep passing against the OLD schema while production gets the new
 * one — the tests would agree with each other and with nothing else.
 *
 * This is the guard against that, and deliberately the ONLY place
 * drizzle-kit is imported in the suite: one process, not thirty.
 */
test("the committed migrations still produce the same schema as schema.ts", async () => {
  // Compared through the catalog rather than by diffing SQL text: the
  // migrations reach today's shape through a pile of ALTERs while the
  // generated DDL creates it in one go, so the two scripts never look
  // alike even when they agree perfectly.
  const columnsQuery = `
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name`;

  // What the migrations build, reached the same way every other test does.
  const migrated = await createTestDb();
  const fromMigrations = (await migrated.$client.query(columnsQuery)).rows;

  // What schema.ts says that should be.
  const client = new PGlite();
  try {
    const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    await client.exec(statements.join("\n"));
    const fromSchema = (await client.query(columnsQuery)).rows;

    assert.deepEqual(
      fromMigrations,
      fromSchema,
      "drizzle/*.sql and schema.ts disagree — run `npx drizzle-kit generate` and commit the migration",
    );
  } finally {
    await client.close();
  }
});
