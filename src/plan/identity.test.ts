import assert from "node:assert/strict";
import { test } from "node:test";
import { idDistance, matchPlanIdentity, stepSimilarity, tokenizeStep, type IdentityEntry, type IdentityRow } from "./identity.ts";

test("tokenizing: lowercase, punctuation and parentheses stripped, stopwords dropped, numbers kept apart", () => {
  const t = tokenizeStep("QC dan pemasangan box kontroler baru (mobil aerolift drone 2)");
  assert.deepEqual([...t.words].sort(), ["controller", "pemasangan", "qc"]); // kontroler -> controller (synonym)
  assert.deepEqual([...t.numbers], ["2"]);
  // en dash and hyphen split; trailing punctuation goes; decimal numbers survive as one token.
  const u = tokenizeStep("Wiring – PSU-utama, tahap 1.5.");
  assert.deepEqual([...u.words].sort(), ["daya", "tahap", "utama", "wiring"]);
  assert.deepEqual([...u.numbers], ["1.5"]);
});

test("same step: identical text, a pure suffix, and a reworded step with enough overlap", () => {
  assert.equal(stepSimilarity("Pembelian komponen", "Pembelian komponen").same, true);
  assert.equal(stepSimilarity("Pembelian komponen", "pembelian  KOMPONEN.").exact, true);
  const suffix = stepSimilarity("Pemasangan kembali box controller ke rak mobil", "Pemasangan kembali box controller ke rak mobil aerolift drone 2");
  assert.equal(suffix.same, true);
  assert.equal(suffix.score, 1);
});

test("different number sets are different steps; a side without numbers is compatible with either", () => {
  assert.equal(stepSimilarity("Pengetesan mobil aerolift drone 1", "Pengetesan mobil aerolift drone 2").same, false);
  assert.equal(stepSimilarity("Pengetesan mobil aerolift drone 1", "Pengetesan mobil aerolift drone 2").numbersCompatible, false);
  assert.equal(stepSimilarity("Pengetesan menyeluruh", "Pengetesan menyeluruh drone 2").same, true);
});

test("a step made only of stopwords is the same only as exactly itself", () => {
  assert.equal(stepSimilarity("drone box", "drone box").same, true);
  assert.equal(stepSimilarity("drone box", "aerolift drone").same, false);
  assert.equal(stepSimilarity("", "").same, false);
});

// The real reshuffle of 2026-10-01 -> 2026-10-03. Old texts are from the 1 Oct import
// (src/scripts/import-aerolift-master-plan-20261001.ts). New texts are the ones the project
// lead quoted from the supervisor's sheet (new 5.03, 5.04, 6.07); new 5.05 and 6.08 are
// ASSUMED to be the old texts unchanged (see the hand-off's open questions).
const OLD = {
  "5.03": "QC dan pemasangan box kontroler baru (mobil aerolift drone 2)",
  "5.04": "Pengetesan mobil aerolift drone 2",
  "5.05": "Wiring box daya mobil aerolift drone 2",
  "6.02": "Pembelian komponen",
  "6.03": "Pembongkaran komponen lama",
  "6.05": "Wiring seluruh komponen",
  "6.06": "Pemasangan kembali box controller ke rak mobil",
  "6.07": "Pengetesan menyeluruh Aerolift Drone",
};
const NEW = {
  "5.03": "Wiring box PSU mobil aerolift drone 2",
  "5.04": "QC dan pemasangan kedua box yang baru di mobil aerolift drone 2",
  "5.05": "Pengetesan mobil aerolift drone 2",
  "6.02": "Pembelian komponen",
  "6.03": "Pembongkaran komponen lama",
  "6.05": "Wiring seluruh komponen",
  "6.07": "Pemasangan kembali box controller ke rak mobil aerolift drone 2",
  "6.08": "Pengetesan menyeluruh Aerolift Drone",
};

test("the real pairs: similarity score and verdict", () => {
  const pairs: Array<[string, string, string, boolean]> = [
    ["old5.03<->new5.04", OLD["5.03"], NEW["5.04"], true],
    ["old5.05<->new5.03", OLD["5.05"], NEW["5.03"], true],
    ["old5.04<->new5.05", OLD["5.04"], NEW["5.05"], true],
    ["old6.06<->new6.07", OLD["6.06"], NEW["6.07"], true],
    ["old6.07<->new6.08", OLD["6.07"], NEW["6.08"], true],
    ["old6.03<->new6.03", OLD["6.03"], NEW["6.03"], true],
    ["old6.02<->new6.02", OLD["6.02"], NEW["6.02"], true],
    ["old6.05<->new6.05", OLD["6.05"], NEW["6.05"], true],
    ["old5.03<->new5.03 (same ID, different step)", OLD["5.03"], NEW["5.03"], false],
  ];
  for (const [name, a, b, expected] of pairs) {
    const sim = stepSimilarity(a, b);
    console.log(`  similarity ${name}: score=${sim.score.toFixed(3)} ${sim.same ? "same" : "different"}`);
    assert.equal(sim.same, expected, name);
  }
  assert.ok(Math.abs(stepSimilarity(OLD["5.03"], NEW["5.04"]).score - 2 / 3) < 1e-9);
  assert.equal(stepSimilarity(OLD["5.05"], NEW["5.03"]).score, 1, "wiring box daya vs wiring box PSU: PSU is a synonym of daya");
  assert.equal(stepSimilarity(OLD["5.05"], NEW["5.03"]).exact, true);
});

const entry = (id: string, step: string, over: Partial<IdentityEntry> = {}): IdentityEntry => ({
  key: `k${id}${over.missing ? "m" : ""}`,
  id,
  area: "A",
  step,
  missing: false,
  ...over,
});
const row = (id: string, step: string, area = "A"): IdentityRow => ({ id, area, step });

test("pass order: kept, then moved, then reappeared, then added/removed", () => {
  const plan = matchPlanIdentity(
    [entry("1.01", "Pasang kabel utama"), entry("1.02", "Uji coba hasil"), entry("1.03", "Rapikan kabel", { missing: true }), entry("1.04", "Langkah yang hilang")],
    [row("1.01", "Pasang kabel utama"), row("1.05", "Uji coba hasil"), row("1.06", "Rapikan kabel"), row("1.07", "Langkah yang sama sekali baru")],
  );
  assert.deepEqual(plan.kept.map((p) => p.row.id), ["1.01"]);
  assert.deepEqual(plan.moved.map((p) => `${p.entry.id}>${p.row.id}`), ["1.02>1.05"]);
  assert.deepEqual(plan.reappeared.map((p) => `${p.entry.id}>${p.row.id}`), ["1.03>1.06"]);
  assert.deepEqual(plan.added.map((r) => r.id), ["1.07"]);
  assert.deepEqual(plan.removed.map((e) => e.id), ["1.04"]);
});

test("IDs swapping between two steps are both recognised as moves", () => {
  const plan = matchPlanIdentity([entry("1.01", "Pasang kabel utama"), entry("1.02", "Uji coba hasil")], [row("1.01", "Uji coba hasil"), row("1.02", "Pasang kabel utama")]);
  assert.equal(plan.kept.length, 0);
  assert.deepEqual(plan.moved.map((p) => `${p.entry.id}>${p.row.id}`).sort(), ["1.01>1.02", "1.02>1.01"]);
});

test("the same ID with a different step is a removal plus an addition, not a rename", () => {
  const plan = matchPlanIdentity([entry("5.03", OLD["5.03"])], [row("5.03", NEW["5.03"])]);
  assert.equal(plan.kept.length + plan.moved.length, 0);
  assert.deepEqual(plan.removed.map((e) => e.id), ["5.03"]);
  assert.deepEqual(plan.added.map((r) => r.id), ["5.03"]);
});

test("moves happen only inside the same area", () => {
  const plan = matchPlanIdentity([entry("1.01", "Pasang kabel utama", { area: "Area A" })], [row("2.01", "Pasang kabel utama", "Area  B")]);
  assert.equal(plan.moved.length, 0);
  const sameAreaOtherSpacing = matchPlanIdentity([entry("1.01", "Pasang kabel utama", { area: "Area A" })], [row("1.09", "Pasang kabel utama", " area   a ")]);
  assert.equal(sameAreaOtherSpacing.moved.length, 1);
});

test("ambiguity: two rows that fit one old step equally well and sit equally far away -> nobody is guessed", () => {
  const plan = matchPlanIdentity(
    [entry("6.06", "Pemasangan kembali box controller ke rak mobil")],
    [row("6.05", "Pemasangan kembali box controller ke rak mobil aerolift drone 1"), row("6.07", "Pemasangan kembali box controller ke rak mobil aerolift drone 2")],
  );
  assert.equal(plan.moved.length, 0);
  assert.deepEqual(plan.removed.map((e) => e.id), ["6.06"]);
  assert.deepEqual(plan.added.map((r) => r.id).sort(), ["6.05", "6.07"]);
  assert.equal(plan.ambiguous.length, 1);
  assert.deepEqual(plan.ambiguous[0]?.entryIds, ["6.06"]);
});

test("ambiguity the other way: two old steps equally good and equally near for one row", () => {
  const plan = matchPlanIdentity(
    [entry("1.04", "Pemasangan rak mobil aerolift drone 1"), entry("1.06", "Pemasangan rak mobil aerolift drone 2")],
    [row("1.05", "Pemasangan rak mobil")],
  );
  assert.equal(plan.moved.length, 0);
  assert.deepEqual(plan.added.map((r) => r.id), ["1.05"]);
  assert.equal(plan.ambiguous.length, 1);
});

test("tie-break by ID distance: the nearer drone-2 row wins over the farther drone-1 twin, from both sides", () => {
  const oldStep = "Pemasangan kembali box controller ke rak mobil";
  const near = "Pemasangan kembali box controller ke rak mobil aerolift drone 2";
  const farTwin = "Pemasangan box controller baru ke rak mobil aerolift drone 1";
  for (const rows of [[row("6.07", near), row("6.13", farTwin)], [row("6.13", farTwin), row("6.07", near)]]) {
    const plan = matchPlanIdentity([entry("6.06", oldStep)], rows);
    assert.deepEqual(plan.moved.map((p) => `${p.entry.id}>${p.row.id}`), ["6.06>6.07"]);
    assert.deepEqual(plan.added.map((r) => r.id), ["6.13"]);
    assert.equal(plan.ambiguous.length, 0);
  }
  // One new row claimed by two old items: the nearer old item gets it.
  const claimed = matchPlanIdentity(
    [entry("6.06", "Pemasangan rak mobil aerolift drone 2"), entry("6.20", "Pemasangan rak mobil aerolift drone 2 ulang")],
    [row("6.07", "Pemasangan rak mobil aerolift drone 2")],
  );
  assert.deepEqual(claimed.moved.map((p) => `${p.entry.id}>${p.row.id}`), ["6.06>6.07"]);
});

test("the real twins: 6.06 -> 6.07 (not 6.13) and 6.07 -> 6.08 (not 6.14)", () => {
  const plan = matchPlanIdentity(
    [entry("6.06", OLD["6.06"]), entry("6.07", OLD["6.07"])],
    [
      row("6.07", NEW["6.07"]),
      row("6.08", "Pengetesan menyeluruh box controller setelah terpasang di mobil Aerolift Drone 2"),
      row("6.13", "Pemasangan box controller baru ke rak mobil aerolift drone 1"),
      row("6.14", "Pengetesan menyeluruh box controller baru setelah terpasang di mobil Aerolift Drone 1"),
    ],
  );
  assert.deepEqual(plan.moved.map((p) => `${p.entry.id}>${p.row.id}`).sort(), ["6.06>6.07", "6.07>6.08"]);
  assert.deepEqual(plan.added.map((r) => r.id).sort(), ["6.13", "6.14"]);
  assert.equal(plan.ambiguous.length, 0);
});

test("synonyms from the real sheet are folded before comparing", () => {
  assert.deepEqual([...tokenizeStep("Wiring box PSU").words].sort(), ["daya", "wiring"]);
  assert.deepEqual([...tokenizeStep("Power kontroler").words].sort(), ["controller", "daya"]);
  assert.equal(stepSimilarity("Pengujian fungsi", "Pengetesan fungsi").exact, true);
  assert.equal(stepSimilarity("Testing sistem", "test sistem").exact, true);
  assert.equal(stepSimilarity(OLD["5.05"], NEW["5.03"]).same, true);
});

test("idDistance compares step numbers inside an area and treats other areas as far", () => {
  assert.equal(idDistance("6.06", "6.07"), 1);
  assert.equal(idDistance("6.06", "6.13"), 7);
  assert.ok(idDistance("6.06", "5.06") > 100);
});

test("an identical text wins over a merely similar one, so a twin does not make a certain match ambiguous", () => {
  const plan = matchPlanIdentity(
    [entry("1.01", "Pengetesan mobil aerolift drone 2"), entry("1.02", "Pengetesan mobil aerolift drone 2 ulang")],
    [row("1.07", "Pengetesan mobil aerolift drone 2")],
  );
  assert.deepEqual(plan.moved.map((p) => `${p.entry.id}>${p.row.id}`), ["1.01>1.07"]);
  assert.deepEqual(plan.removed.map((e) => e.id), ["1.02"]);
});
