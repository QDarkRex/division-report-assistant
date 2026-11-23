import assert from "node:assert/strict";
import { test } from "node:test";
import { matchProjectInText } from "./matching.ts";

const TERMS = [
  { projectId: "p-Alpha", name: "Drone Alpha", terms: ["Drone Alpha", "Alpha", "docking Alpha"] },
  { projectId: "p-Beta", name: "Drone Beta", terms: ["Drone Beta", "Beta", "vega"] },
  { projectId: "p-meja", name: "Meja Alpha", terms: ["Meja Alpha", "meja", "lifting table"] },
  { projectId: "p-fake", name: "Epsilon", terms: ["Epsilon", "Epsilon"] },
  { projectId: "p-Zeta", name: "Zeta rig", terms: ["Zeta rig", "Zeta rig", "Zeta"] },
  { projectId: "p-rc", name: "RC car", terms: ["RC car", "rc car", "rc"] },
];

test("a single named project in a sentence is matched", () => {
  const match = matchProjectInText("Soldering PCB BMS Epsilon", TERMS);
  assert.equal(match?.name, "Epsilon");
});

// The whole reason this exists: resolveProjectsByNameOrAlias does an exact
// ilike, so a project name inside a sentence never matched and the Sheets
// Proyek column stayed empty for every item without a task.
test("matching works mid-sentence, not only on an exact whole-string equality", () => {
  assert.equal(matchProjectInText("Melanjutkan wiring panel docking Beta hari ini", TERMS)?.name, "Drone Beta");
});

test("the longest matching term is reported as the evidence", () => {
  const match = matchProjectInText("perapihan kabel docking Alpha", TERMS);
  assert.equal(match?.name, "Drone Alpha");
  assert.equal(match?.matchedTerm, "docking Alpha", "the specific phrase, not the bare 'Alpha'");
});

// Owner confirmed 2026-08-31 that lifter and antenna tracker exist in BOTH
// dockings, and was unsure themselves. Text pointing at two projects is a
// question for a human, never a tie for code to break.
test("text naming two different projects resolves to nothing", () => {
  assert.equal(matchProjectInText("testing controller meja Alpha", TERMS), null);
});

test("text naming no project resolves to nothing", () => {
  assert.equal(matchProjectInText("Melanjutkan pembuatan PCB", TERMS), null);
  assert.equal(matchProjectInText("Mengurus pengajuan barang", TERMS), null);
});

// Word boundaries matter: without them "rc" would fire inside ordinary
// Indonesian words and quietly attribute half the division to RC car.
test("a short alias only matches as a whole word", () => {
  assert.equal(matchProjectInText("uji coba rc car dilintasan", TERMS)?.name, "RC car");
  assert.equal(matchProjectInText("melakukan riset arcing pada kontaktor", TERMS), null);
  assert.equal(matchProjectInText("memasang bracket", TERMS), null);
});

test("matching ignores case", () => {
  assert.equal(matchProjectInText("TESTING VEGA CAMERA", TERMS)?.name, "Drone Beta");
});

// "Zeta rig" contains "Zeta", and Epsilon contains "Epsilon" —
// sibling projects with overlapping vocabulary are exactly where a greedy
// matcher would misattribute a prototype's work to the wrong line.
test("sibling wifi projects are told apart by their own terms", () => {
  assert.equal(matchProjectInText("soldering pcb bms Zeta rig", TERMS)?.name, "Zeta rig");
  assert.equal(matchProjectInText("troubleshoot Epsilon op amp rusak", TERMS)?.name, "Epsilon");
});

test("a project mentioned twice is still one match, not an ambiguity", () => {
  assert.equal(matchProjectInText("wiring Alpha dan testing docking Alpha", TERMS)?.name, "Drone Alpha");
});

test("empty or whitespace terms never match everything", () => {
  const withBlank = [{ projectId: "p-x", name: "X", terms: ["X", "  ", ""] }];
  assert.equal(matchProjectInText("apapun teksnya", withBlank), null);
});
