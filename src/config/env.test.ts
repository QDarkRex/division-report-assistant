import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./env.ts";

const BASE = { DATABASE_URL: "postgres://x", WHATSAPP_GROUP_JID: "120363000000000000@g.us" };

test("PLAN_SPREADSHEET_ID: unset and the empty string compose.yaml passes (WDH_PLAN_SPREADSHEET_ID:-) both mean plan sync is off", () => {
  assert.equal(loadConfig({ ...BASE }).PLAN_SPREADSHEET_ID, undefined);
  assert.equal(loadConfig({ ...BASE, PLAN_SPREADSHEET_ID: "" }).PLAN_SPREADSHEET_ID, undefined);
  assert.equal(loadConfig({ ...BASE, PLAN_SPREADSHEET_ID: "   " }).PLAN_SPREADSHEET_ID, undefined);
  assert.equal(loadConfig({ ...BASE, PLAN_SPREADSHEET_ID: "abc123" }).PLAN_SPREADSHEET_ID, "abc123");
});

test("blank optional PLAN_* settings fall back to their defaults instead of failing the boot", () => {
  const config = loadConfig({ ...BASE, PLAN_SHEET_NAME: "", PLAN_SOURCE_KEY: "", PLAN_PROJECT_NAME: "" });
  assert.equal(config.PLAN_SHEET_NAME, "Master Plan");
  assert.equal(config.PLAN_SOURCE_KEY, "aerolift");
  assert.equal(config.PLAN_PROJECT_NAME, "Aerolift Drone Mobil");
  assert.throws(() => loadConfig({ ...BASE, PLAN_SOURCE_KEY: "Bad Key" }));
});
