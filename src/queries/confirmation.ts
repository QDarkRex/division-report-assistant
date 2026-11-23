import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { pendingConfirmations, reportItems, reportRevisions } from "../db/schema.ts";
import type { QueryIntent } from "../llm/schemas.ts";
import { clockLabel } from "./overtime-intent.ts";

/**
 * The intents that CHANGE state. Every one is proposed and confirmed before
 * it runs (owner decision 2026-09-12), because an LLM-classified mutation is
 * only ever as safe as the classification — and a question misread as a
 * check-in already filed the wrong person once. Read-only intents are absent
 * here and run immediately.
 */
const MUTATING_INTENTS = new Set<QueryIntent["intent"]>([
  "set_availability",
  "cancel_availability",
  "create_task",
  "overtime_checkin",
  "overtime_checkout",
]);

export function isMutatingIntent(intent: QueryIntent): boolean {
  return MUTATING_INTENTS.has(intent.intent);
}

/**
 * A confirmation reply is recognised deterministically — never by the LLM,
 * which is the thing being double-checked. Only a small, unambiguous set of
 * words counts, matched on the whole message (after the @mention is
 * stripped upstream) so "ya sudah beres kok" is not read as a confirm.
 */
export const CONFIRM_WORDS = new Set(["ya", "iya", "iyah", "yes", "ok", "oke", "okay", "betul", "benar", "lanjut", "gas", "gaskeun", "setuju", "y"]);
export const CANCEL_WORDS = new Set(["batal", "bukan", "tidak", "ga", "gak", "engga", "enggak", "nggak", "no", "gajadi", "batalkan", "cancel"]);

export type ConfirmationReply = "confirm" | "cancel" | null;

export function parseConfirmationReply(text: string): ConfirmationReply {
  const word = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (CONFIRM_WORDS.has(word)) return "confirm";
  if (CANCEL_WORDS.has(word)) return "cancel";
  return null;
}

/** A parked query mutation is only good for half an hour: a stray "ya" must not run it later. */
export const QUERY_PENDING_TTL_MS = 30 * 60 * 1000;
/**
 * A report_match question lives much longer (project-lead decision
 * 2026-10-04): members answer the plan-match questions when they next look at
 * their phone, often hours after reporting, and a late "2 ya" only links an
 * item that was already reported — it cannot run anything dangerous.
 */
export const REPORT_MATCH_PENDING_TTL_MS = 12 * 60 * 60 * 1000;

function ttlFor(kind: string): number {
  return kind === "report_match" ? REPORT_MATCH_PENDING_TTL_MS : QUERY_PENDING_TTL_MS;
}

/**
 * One numbered plan-related item of a report, as the reporter saw it in the
 * acknowledgment. `n` is the number they answer with ("@helper 2 ya").
 *
 *  - 'linked': the model was sure; the item IS linked to `taskId`. Kept so the
 *    reporter can still say "1 bukan" or "1 = 1.04".
 *  - 'question': the model was unsure; the item is NOT linked yet and waits
 *    for ya/bukan. `flagId` is its open low_confidence flag.
 *
 * `flagId` is null for a 'linked' item (no question was ever asked).
 */
export interface ReportMatchItem {
  n: number;
  itemId: string;
  taskId: string;
  planRef: string;
  flagId: string | null;
  state: "linked" | "question";
}

/**
 * The plan-related items of a member's recent report(s), parked until the
 * reporter answers. Stored in pending_confirmations.intent (jsonb) — no schema
 * change. `reportId` is the report that last touched the row; items of an
 * earlier report (another day) can sit beside it after a merge, each item's
 * own report being found through its itemId.
 */
export interface ReportMatchPayload {
  reportId: string;
  items: ReportMatchItem[];
}

/**
 * Rows written before per-item confirmation have items without `n`/`state`
 * (and always with a flagId): every one of them was an open question. Read
 * them as such, numbered in stored order, so a deploy does not strand them.
 */
export function normalizeReportMatchPayload(raw: unknown): ReportMatchPayload {
  const value = (raw ?? {}) as { reportId?: string; items?: Array<Partial<ReportMatchItem>> };
  const items = (value.items ?? []).map((item, index) => ({
    n: typeof item.n === "number" ? item.n : index + 1,
    itemId: item.itemId as string,
    taskId: item.taskId as string,
    planRef: item.planRef as string,
    flagId: item.flagId ?? null,
    state: item.state === "linked" ? ("linked" as const) : ("question" as const),
  }));
  return { reportId: value.reportId as string, items };
}

/**
 * What a member is currently being asked. There is ONE row per member whatever
 * the kind (pending_confirmations in db/schema.ts), and the latest proposal
 * wins. A report that asks "benar task ini?" therefore replaces a query
 * confirmation that was still waiting (and vice versa); the replaced question
 * simply expires, which for a report match leaves its flags 'open' for the
 * admins' morning summary. The one exception is report against report: a new
 * report MERGES into a pending report_match instead of replacing it (see
 * mergePendingReportMatch).
 */
export type PendingConfirmation = (
  | { kind: "query"; intent: QueryIntent }
  | { kind: "report_match"; match: ReportMatchPayload }
) & {
  /**
   * When the question was asked. For a parked query this is the moment of the
   * ORIGINAL message, which is what a deferred mutation must be dated by: a
   * "ya" at 10:01 to a check-in asked at 09:59 still means the 09:59 day.
   */
  createdAt: Date;
};

async function upsertPending(db: AppDatabase, memberId: string, kind: string, intent: unknown, now: Date): Promise<void> {
  await db
    .insert(pendingConfirmations)
    .values({ memberId, kind, intent, createdAt: now })
    .onConflictDoUpdate({ target: pendingConfirmations.memberId, set: { kind, intent, createdAt: now } });
}

export async function setPendingConfirmation(db: AppDatabase, memberId: string, intent: QueryIntent, now: Date): Promise<void> {
  await upsertPending(db, memberId, "query", intent, now);
}

export async function setPendingReportMatch(db: AppDatabase, memberId: string, match: ReportMatchPayload, now: Date): Promise<void> {
  await upsertPending(db, memberId, "report_match", match, now);
}

/** Rewrites a pending report_match in place WITHOUT restarting its clock — answering one item must not extend the others' 12 hours. */
export async function updatePendingReportMatch(db: AppDatabase, memberId: string, match: ReportMatchPayload): Promise<void> {
  await db
    .update(pendingConfirmations)
    .set({ intent: match })
    .where(and(eq(pendingConfirmations.memberId, memberId), eq(pendingConfirmations.kind, "report_match")));
}

/** The member's pending confirmation if one exists and has not aged out (30 min for a query, 12 h for a report match), else null. Expiry is enforced here so a stale "ya" cannot fire it. */
export async function getPendingConfirmation(db: AppDatabase, memberId: string, now: Date): Promise<PendingConfirmation | null> {
  const [row] = await db.select().from(pendingConfirmations).where(eq(pendingConfirmations.memberId, memberId)).limit(1);
  if (!row) return null;
  if (row.createdAt.getTime() <= now.getTime() - ttlFor(row.kind)) return null;
  if (row.kind === "report_match") return { kind: "report_match", match: normalizeReportMatchPayload(row.intent), createdAt: row.createdAt };
  return { kind: "query", intent: row.intent as QueryIntent, createdAt: row.createdAt };
}

/**
 * A bare "ya"/"batal" (no @mention) counts as an answer only while the
 * question is fresh. Production 2026-10-08: a member replied "Ya" to a
 * confirmation and was ignored because he did not tag the bot. The window is
 * short on purpose — unlike a tagged "@helper ya", an untagged "ya" is also
 * ordinary chat, so it may only be read as an answer right after the bot asked.
 */
export const BARE_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

/** True when `text` is a whole-message confirm/cancel word AND the sender has an unexpired pending confirmation asked at most 5 minutes ago. */
export async function isBareConfirmationForPending(db: AppDatabase, memberId: string, text: string, now: Date): Promise<boolean> {
  if (parseConfirmationReply(text) === null) return false;
  const pending = await getPendingConfirmation(db, memberId, now);
  if (!pending) return false;
  const age = now.getTime() - pending.createdAt.getTime();
  return age >= 0 && age <= BARE_CONFIRMATION_WINDOW_MS;
}

/** The ids, among `itemIds`, that belong to the LATEST revision of their report. An older revision's item was superseded by a correction and must not be answered any more. */
export async function currentItemIds(db: AppDatabase, itemIds: readonly string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db
    .select({ itemId: reportItems.itemId, revisionId: reportItems.revisionId, reportId: reportRevisions.reportId })
    .from(reportItems)
    .innerJoin(reportRevisions, eq(reportItems.revisionId, reportRevisions.revisionId))
    .where(inArray(reportItems.itemId, [...itemIds]));
  const reportIds = [...new Set(rows.map((r) => r.reportId))];
  if (reportIds.length === 0) return new Set();
  const revisions = await db
    .select({ revisionId: reportRevisions.revisionId, reportId: reportRevisions.reportId, revisionNumber: reportRevisions.revisionNumber })
    .from(reportRevisions)
    .where(inArray(reportRevisions.reportId, reportIds));
  const latest = new Map<string, { revisionId: string; revisionNumber: number }>();
  for (const rev of revisions) {
    const known = latest.get(rev.reportId);
    if (!known || rev.revisionNumber > known.revisionNumber) latest.set(rev.reportId, rev);
  }
  return new Set(rows.filter((r) => latest.get(r.reportId)?.revisionId === r.revisionId).map((r) => r.itemId));
}

/**
 * A report just produced these plan-related items (linked ones and questions);
 * fold them into the member's pending report_match and return them numbered.
 *
 *  - An existing, unexpired report_match is KEPT, minus every item that a
 *    revision has since superseded (its revision is no longer the latest of
 *    its report) — a second report, or a corrected one, no longer wipes out
 *    questions still open from another day.
 *  - New items are appended with numbers continuing after the highest kept
 *    number, so a number the reporter has already seen never changes meaning.
 *    Linked items come first, then questions, as the acknowledgment lists them.
 *  - A pending QUERY confirmation is replaced (latest wins, as before).
 *  - With nothing new, an existing report_match is only pruned (and removed
 *    when nothing is left); its clock is not restarted.
 *
 * The 12-hour clock restarts whenever new items are added.
 */
export async function mergePendingReportMatch(
  db: AppDatabase,
  memberId: string,
  reportId: string,
  fresh: ReadonlyArray<Omit<ReportMatchItem, "n">>,
  now: Date,
): Promise<ReportMatchItem[]> {
  const pending = await getPendingConfirmation(db, memberId, now);
  const existing = pending?.kind === "report_match" ? pending.match : null;

  let kept: ReportMatchItem[] = [];
  if (existing) {
    const current = await currentItemIds(db, existing.items.map((i) => i.itemId));
    kept = existing.items.filter((i) => current.has(i.itemId));
  }

  if (fresh.length === 0) {
    if (existing && kept.length !== existing.items.length) {
      if (kept.length === 0) await clearPendingConfirmation(db, memberId);
      else await updatePendingReportMatch(db, memberId, { reportId: existing.reportId, items: kept });
    }
    return [];
  }

  const base = kept.reduce((max, item) => Math.max(max, item.n), 0);
  const ordered = [...fresh.filter((i) => i.state === "linked"), ...fresh.filter((i) => i.state === "question")];
  const numbered: ReportMatchItem[] = ordered.map((item, index) => ({ ...item, n: base + index + 1 }));
  await setPendingReportMatch(db, memberId, { reportId, items: [...kept, ...numbered] }, now);
  return numbered;
}

export async function clearPendingConfirmation(db: AppDatabase, memberId: string): Promise<void> {
  await db.delete(pendingConfirmations).where(eq(pendingConfirmations.memberId, memberId));
}

/**
 * A short, human-readable summary of what a mutating intent would do, for
 * the confirmation prompt. Deliberately built from the parsed parameters,
 * so a misread ACTION ("absen lembur" when the member asked a question) is
 * visible even if the exact date is not spelled out — the execute reply
 * echoes the precise days/names once confirmed.
 */
export function describeIntent(intent: QueryIntent): string {
  const who = intent.targetMemberNames?.length
    ? intent.targetMemberNames.join(" dan ")
    : intent.targetMemberName ?? "kamu";
  const time = intent.timeText ? ` ${clockLabel(intent.timeText)}` : "";
  switch (intent.intent) {
    case "set_availability": {
      const kind = intent.availabilityKind ?? "izin/cuti/sakit";
      const reason = intent.availabilityReason ? ` (${intent.availabilityReason})` : "";
      return `Catat ${kind} untuk ${who}${reason}`;
    }
    case "cancel_availability":
      return `Batalkan catatan izin/cuti/sakit ${who}`;
    case "create_task":
      return `Buat task "${intent.taskTitle ?? "(tanpa judul)"}" untuk ${who}`;
    case "overtime_checkin":
      return `Absen lembur${time}`;
    case "overtime_checkout":
      return `Catat selesai lembur${time}`;
    default:
      return "aksi ini";
  }
}
