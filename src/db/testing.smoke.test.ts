import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "./testing.ts";
import { members } from "./schema.ts";

test("createTestDb pushes schema and allows insert/select", async () => {
  const [db, isolatedDb] = await Promise.all([createTestDb(), createTestDb()]);
  const [inserted] = await db
    .insert(members)
    .values({ preferredName: "Budi", role: "member", membershipStatus: "active" })
    .returning();
  assert.ok(inserted?.memberId);

  const rows = await db.select().from(members);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.preferredName, "Budi");

  assert.equal((await isolatedDb.select().from(members)).length, 0);
  await isolatedDb.insert(members).values({
    preferredName: "Ayu",
    role: "member",
    membershipStatus: "active",
  });
  assert.deepEqual(
    (await db.select({ preferredName: members.preferredName }).from(members)).map((row) => row.preferredName),
    ["Budi"],
  );
});

test("createTestDb starts from a clean schema after prior test cleanup", async () => {
  const db = await createTestDb();
  assert.deepEqual(await db.select().from(members), []);
});
