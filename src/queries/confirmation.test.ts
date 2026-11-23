import assert from "node:assert/strict";
import { test } from "node:test";
import { describeIntent, isMutatingIntent, parseConfirmationReply } from "./confirmation.ts";
import type { QueryIntent } from "../llm/schemas.ts";

function intent(over: Partial<QueryIntent>): QueryIntent {
  return { intent: "unknown", ...over } as QueryIntent;
}

test("mutating intents are flagged; read-only ones are not", () => {
  for (const i of ["set_availability", "cancel_availability", "create_task", "overtime_checkin", "overtime_checkout"]) {
    assert.equal(isMutatingIntent(intent({ intent: i as QueryIntent["intent"] })), true, i);
  }
  for (const i of ["missing_reporters", "member_tasks", "overtime_today", "tasks_today", "unknown"]) {
    assert.equal(isMutatingIntent(intent({ intent: i as QueryIntent["intent"] })), false, i);
  }
});

test("confirmation words are matched only on the whole message", () => {
  assert.equal(parseConfirmationReply("ya"), "confirm");
  assert.equal(parseConfirmationReply("Iya."), "confirm");
  assert.equal(parseConfirmationReply("batal"), "cancel");
  assert.equal(parseConfirmationReply("gajadi"), "cancel");
  // Not a bare affirmative — must not be read as a confirm.
  assert.equal(parseConfirmationReply("ya sudah beres kok"), null);
  assert.equal(parseConfirmationReply("siapa yang lembur"), null);
});

test("the description names the action so a misread is visible", () => {
  assert.match(describeIntent(intent({ intent: "overtime_checkin", timeText: "17:00" })), /Absen lembur jam 17:00/);
  assert.match(describeIntent(intent({ intent: "create_task", taskTitle: "Cek panel", targetMemberNames: ["Nisa", "Udin"] })), /Cek panel.*Nisa dan Udin/);
  assert.match(describeIntent(intent({ intent: "set_availability", availabilityKind: "izin" })), /izin.*kamu/);
});
