import assert from "node:assert/strict";
import { test } from "node:test";
import { isReplayedMessage } from "./replay.ts";

test("a message received within a few seconds of its own timestamp is live", () => {
  const messageTimestamp = new Date("2026-08-07T03:00:00.000Z");
  const receivedAt = new Date("2026-08-07T03:00:02.000Z");
  assert.equal(isReplayedMessage(messageTimestamp, receivedAt), false);
});

test("a message received hours after its own timestamp is a reconnect replay", () => {
  const messageTimestamp = new Date("2026-08-07T03:00:00.000Z");
  const receivedAt = new Date("2026-08-07T06:15:00.000Z");
  assert.equal(isReplayedMessage(messageTimestamp, receivedAt), true);
});

test("threshold is configurable", () => {
  const messageTimestamp = new Date("2026-08-07T03:00:00.000Z");
  const receivedAt = new Date("2026-08-07T03:00:30.000Z");
  assert.equal(isReplayedMessage(messageTimestamp, receivedAt, 60_000), false);
  assert.equal(isReplayedMessage(messageTimestamp, receivedAt, 10_000), true);
});
