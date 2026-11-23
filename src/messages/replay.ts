/**
 * MASTER_SPEC.md §16: "No automatic backlog processing on reconnect." The
 * architecture doc says this but names no mechanism — Baileys delivers
 * queued offline messages through the same `onMessage` handler as live
 * ones, so without an explicit check, a multi-hour outage silently
 * replays every queued message through the LLM/state-mutation pipeline.
 * Chief-review finding, Phase 1 follow-up.
 *
 * A replayed message carries WhatsApp's own `messageTimestamp`, which
 * predates the moment we actually received it — a live message's own
 * timestamp and our ingestion time are always within a few seconds of each
 * other. This threshold-based heuristic needs no outage-interval bookkeeping
 * and treats the replay/live boundary as an ingestion-time property of the
 * message itself.
 */
export const DEFAULT_REPLAY_THRESHOLD_MS = 60_000;

export function isReplayedMessage(
  messageTimestamp: Date,
  receivedAt: Date,
  thresholdMs: number = DEFAULT_REPLAY_THRESHOLD_MS,
): boolean {
  return receivedAt.getTime() - messageTimestamp.getTime() > thresholdMs;
}
