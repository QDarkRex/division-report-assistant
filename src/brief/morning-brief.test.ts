import assert from "node:assert/strict";
import { test } from "node:test";
import { dailySummaries, planItemChanges } from "../db/schema.ts";
import { fromJakartaWallClock } from "../shared/time.ts";
import { composeMorningBrief, persistMorningBrief } from "./morning-brief.ts";
import { BRIEF_NOW, seedBriefWorld } from "./testing.ts";

test("compose without an LLM renders the facts and says why there is no model output", async () => {
  const { db } = await seedBriefWorld();
  const brief = await composeMorningBrief(db, {}, BRIEF_NOW);

  assert.equal(brief.llm, null);
  assert.equal(brief.llmError, null);
  assert.match(brief.text, /progress 38%/);
  assert.ok(brief.text.length < 3500);
});

test("persisting twice for one day keeps one row, and the next brief only announces changes made after it was sent", async () => {
  const { db, taskIds } = await seedBriefWorld();

  const first = await composeMorningBrief(db, {}, BRIEF_NOW);
  assert.match(first.text, /\[5\.02\] Berjalan → Selesai/);
  await persistMorningBrief(db, first, BRIEF_NOW);
  await persistMorningBrief(db, first, new Date(BRIEF_NOW.getTime() + 60_000));
  assert.equal((await db.select().from(dailySummaries)).length, 1, "a pg-boss retry must not add a second row for the day");

  await db.insert(planItemChanges).values({
    planRef: "aerolift:4.03",
    taskId: taskIds["4.03"]!,
    field: "progress",
    oldValue: "10%",
    newValue: "40%",
    detectedAt: fromJakartaWallClock(2026, 10, 3, 14, 0),
  });
  const second = await composeMorningBrief(db, {}, fromJakartaWallClock(2026, 10, 4, 8, 0));

  assert.equal(second.facts.sinceSource, "previous_brief");
  assert.deepEqual(second.facts.planChanges.map((g) => g.id), ["4.03"], "5.02 was announced yesterday and is not repeated");
});
