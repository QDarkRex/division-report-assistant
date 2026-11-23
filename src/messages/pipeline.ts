import type { AppDatabase } from "../db/types.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";
import type { LlmClientConfig } from "../llm/client.ts";
import { callLlmForJson, LlmCallError } from "../llm/client.ts";
import { buildRestoreDictionary, redactForLlm, restoreEntities } from "../llm/redaction.ts";
import { ReportExtractionSchema } from "../llm/schemas.ts";
import { getCurrentBudgetStatus, maxTaskCandidatesFor } from "../llm/budget.ts";
import { recordFailedInvocation, recordInvocation } from "../llm/cost.ts";
import { isAlreadyProcessed, markProcessed, recordIncomingMessage, toIncomingMessageInput } from "./ingestion.ts";
import { storeCandidateContext } from "./context.ts";
import { hasReportHeader, looksLikeReportAttempt } from "../reports/header.ts";
import { normalizeIncomingText } from "./normalize.ts";
import { reportKindFor } from "../reports/kind.ts";
import { loadProjectTerms, matchProjectInText } from "../projects/matching.ts";
import {
  addReportItem,
  clearNoActivity,
  addRevision,
  getDailyReport,
  getLatestRevision,
  getOrCreateDailyReport,
  listItemsForRevision,
  markNoActivity,
  summarizeRevision,
} from "../reports/service.ts";
import type { ReportSummary } from "../reports/types.ts";
import { resolveMemberByJid } from "../members/service.ts";
import type { Member } from "../members/types.ts";
import { claimTask, findTaskByNormalizedTitle, getTask, listTasksByStatus, transitionStatus } from "../tasks/service.ts";
import type { Task } from "../tasks/types.ts";
import type { StatusTransitionTrigger } from "../tasks/state-machine.ts";
import { CANDIDATE_TASKS_ENABLED, createCandidateTask } from "../tasks/candidates.ts";
import { formatCalendarDay, reportingDayFor } from "../shared/time.ts";
import type { ReportKind } from "../reports/types.ts";
import type { ReportItemStatus } from "../reports/types.ts";
import { extractHelperQuery } from "../queries/mention.ts";
import { answerQuery } from "../queries/service.ts";
import { isBareConfirmationForPending, mergePendingReportMatch, type ReportMatchItem } from "../queries/confirmation.ts";
import { FLAG_LOW_CONFIDENCE, findFlag, raiseFlag } from "../plan/flags.ts";
import {
  buildExtractionCandidates,
  formatCandidateLine,
  loadPlanContext,
  raiseNoUrgentWorkFlag,
  raisePlanFlags,
  type ExtractionCandidate,
  type PlanContext,
} from "../plan/matching.ts";

/**
 * System prompt: byte-stable across calls (never interpolate per-call data
 * here) so DeepSeek's prefix cache actually gets hit — the ADR-0010
 * addendum's cost-control commitment. Per-call variable content (the
 * redacted report text, task candidates) goes in the user message.
 *
 * Extended 2026-08-09 with obstacleCategory instructions (d2, obstacle
 * categorization) — this is a real, one-time edit to prompt text that
 * was deliberately kept stable, so it invalidates DeepSeek's prefix
 * cache exactly once on the next call. Expected, not a regression if a
 * cost dashboard shows a one-time blip right after this deploy.
 *
 * Extended again for plan matching (matchConfidence/matchReason and the
 * "match by meaning" rules): another one-time cache invalidation.
 */
const REPORT_EXTRACTION_SYSTEM_PROMPT = `Anda mengekstrak data terstruktur dari laporan kerja WhatsApp harian divisi listrik (Electrical Division).

Setiap laporan berisi satu atau lebih aktivitas. Untuk setiap aktivitas, ekstrak:
- activity: deskripsi singkat pekerjaan yang dilakukan
- result (opsional): hasil pekerjaan tersebut, jika disebutkan
- obstacle (opsional): kendala yang dialami, jika disebutkan
- obstacleCategory (opsional): kategori kendala, HANYA isi jika ada obstacle. Salah satu dari:
  - "waiting_material": menunggu bahan/material
  - "waiting_component": menunggu komponen/spare part
  - "waiting_information": menunggu informasi/data
  - "technical_issue": kendala teknis umum
  - "software_issue": kendala software/firmware
  - "hardware_issue": kendala hardware/fisik
  - "dependency": menunggu pekerjaan/task lain selesai dulu
  - "resource_unavailable": alat/orang/akses tidak tersedia
  - "needs_decision": butuh keputusan dari admin/atasan
  - "other": kendala lain yang tidak cocok kategori di atas
  Kosongkan (jangan isi field ini) jika tidak ada kendala.
- status: salah satu dari "worked_on", "in_progress", "testing", "blocked", "done", "unknown"
- matchedTaskId (opsional): ID task (UUID) yang cocok dari daftar "TASK AKTIF TERKAIT" yang diberikan, JANGAN mengarang ID
- matchConfidence (opsional, HANYA jika matchedTaskId terisi): "high" jika jelas pekerjaan yang sama dengan task itu, "low" jika hanya mirip atau ragu
- matchReason (opsional, HANYA jika matchedTaskId terisi): alasan singkat (satu kalimat pendek) kenapa task itu cocok

Aturan status penting:
- "test", "testing", "uji coba" -> status "testing", BUKAN "done", walau hasil ujinya berhasil.
- Hanya gunakan "done" jika pekerjaan benar-benar tuntas/selesai/final.
- Jika laporan menyatakan tidak ada aktivitas hari ini, kembalikan noActivity: true dan items kosong.

Mencocokkan aktivitas dengan task di daftar "TASK AKTIF TERKAIT":
- Cocokkan berdasarkan MAKNA pekerjaan, bukan kata yang persis sama. Contoh: "solder indikator LED" cocok dengan task "Soldering PCB indikator LED".
- Daftar itu memuat task milik pengirim laporan di urutan paling atas, lalu task lain yang jadwalnya mencakup hari laporan, lalu task umum. Utamakan task milik pengirim jika ada yang masuk akal.
- Task Master Plan ditulis dengan ID langkah seperti [3.07], lengkap dengan PIC, jadwal, dan status plan. Itu hanya petunjuk — tetap cocokkan berdasarkan isi pekerjaannya.
- Isi matchedTaskId dengan ID task tersebut dan matchConfidence "high" bila aktivitas jelas merupakan pekerjaan yang sama. Bila hanya mirip, topiknya umum, ada beberapa task yang sama-sama mungkin, atau laporannya terlalu singkat, isi matchedTaskId dengan tebakan terbaik tetapi matchConfidence "low". Lebih baik "low" daripada menebak "high".
- Satu aktivitas hanya boleh cocok dengan satu task. Jika tidak ada yang masuk akal, biarkan matchedTaskId kosong — sistem akan membuat task kandidat baru secara otomatis, jangan mencoba menanganinya sendiri.

Balas HANYA dengan satu objek JSON valid sesuai skema di atas. Tidak ada teks lain, tidak ada markdown.`;

export interface PipelineDeps {
  db: AppDatabase;
  llm: LlmClientConfig;
  model?: string;
  now?: Date;
}

export type PipelineOutcome =
  | { status: "duplicate" }
  | { status: "replayed" }
  | { status: "unrecognized_sender"; promptRegister: boolean }
  | { status: "stored_as_context" }
  /**
   * The message opens like a report (report/laporan/lapor, body-sized) but its
   * header was not recognised, so nothing was recorded. The sender is told,
   * instead of being left to believe it landed.
   */
  | { status: "report_not_recorded" }
  /** An exact re-send of the report's latest revision: nothing to do, but say so. */
  | { status: "report_unchanged" }
  | {
      status: "query_answered";
      replyText: string;
      /** Which path decided the intent (overtime pre-classifier, LLM, or a confirmed parked intent); logged by the caller. */
      intentSource?: "pre_classifier" | "llm" | "confirmation";
      /** Present only for export_daily_report — the caller sends it as a document. */
      attachment?: { content: Buffer; fileName: string; mimeType: string };
    }
  | ReportOutcome;

/**
 * What the acknowledgment says about the master plan: the plan tasks this
 * report was linked to, and the low-confidence guesses still waiting on the
 * reporter's "ya"/"bukan". Nothing else about plan matching (the admin-only
 * flags) is carried here — the reporter is never shown those.
 */
export interface PlanAckData {
  /** `n` is the number the reporter answers with; it is shared across `linked` and `questions` (see pending_confirmations kind 'report_match'). */
  linked: Array<{ n: number; activity: string; title: string; sourceReference: string | null }>;
  questions: Array<{ n: number; activity: string; task: { title: string; sourceReference: string | null } }>;
}

export type ReportOutcome =
  | {
      status: "report_processed";
      reportId: string;
      summary: ReportSummary;
      memberName: string;
      overtime: boolean;
      /** Present only when the report touched the master plan; see PlanAckData. */
      plan?: PlanAckData;
    }
  | { status: "report_no_activity"; reportId: string; memberName: string }
  | {
      status: "report_extraction_failed";
      memberName: string;
      /**
       * True when we never got a usable answer OUT of the gateway — a
       * transport error, or an availability status after the client's own
       * transient retries gave up. The report itself may be perfectly
       * fine, so the message stays un-processed and a redelivery gets
       * another go.
       *
       * False when the model answered and the content could not be made to
       * fit the schema after the repair budget. Retrying that spends
       * tokens to fail identically, so it is marked processed and the
       * sender is asked to resend instead.
       */
      retryable: boolean;
    };

/**
 * Maps a report item's LLM-classified status onto a task state-machine
 * trigger. Found missing 2026-08-07: pipeline.ts called claimTask() but
 * never transitionStatus() — tasks were created and contributed-to but
 * their status never moved, so "done" reports never marked anything done.
 * "unknown" intentionally maps to no trigger (no signal to act on).
 * "testing" maps to the same trigger as "worked_on"/"in_progress" — per
 * ACCEPTANCE_TESTS.md §2.2 testing is explicitly NOT done, but it is still
 * active work, so it should still move active -> in_progress.
 */
function triggerForReportItemStatus(status: ReportItemStatus): StatusTransitionTrigger | null {
  switch (status) {
    case "worked_on":
    case "in_progress":
    case "testing":
      return "member_reports_work";
    case "blocked":
      return "obstacle_reported";
    case "done":
      return "member_marks_done";
    case "unknown":
      return null;
  }
}

/**
 * Applies the transition if valid for the task's current status, silently
 * no-ops otherwise (e.g. a second "worked_on" report on an
 * already-in_progress task has no valid transition — that's expected, not
 * an error, and must not abort the rest of the report).
 */
async function applyReportStatusToTask(
  db: AppDatabase,
  taskId: string,
  itemStatus: ReportItemStatus,
  actorMemberId: string,
): Promise<void> {
  const trigger = triggerForReportItemStatus(itemStatus);
  if (!trigger) return;
  try {
    await transitionStatus(db, taskId, trigger, actorMemberId);
  } catch {
    // No valid transition from the task's current status for this trigger — benign.
  }
}

function buildReportUserContent(redactedText: string, candidates: readonly ExtractionCandidate[]): string {
  const candidateLines = candidates.length > 0 ? candidates.map(formatCandidateLine).join("\n") : "Tidak ada task terkait.";

  return `LAPORAN (setelah redaksi):\n"""\n${redactedText}\n"""\n\nTASK AKTIF TERKAIT (kandidat pencocokan; task milik pengirim ada di urutan paling atas):\n${candidateLines}`;
}

/**
 * The report-extraction-and-persist core, factored out (2026-08-08) so it
 * can be called two ways: from processIncomingMessage() for live messages,
 * and from scripts/reprocess-message.ts for admin recovery of a message
 * that's already durably stored but never made it into a report — a
 * dedup/replay-check bypass a live message must never get, but a message
 * an admin is deliberately re-running by hand should. Bypassing dedup here
 * (not in this function, in the caller) is exactly why this exists as a
 * separate function rather than a flag on processIncomingMessage.
 */
export async function processReportContent(
  db: AppDatabase,
  llm: LlmClientConfig,
  sender: Member,
  reportText: string,
  sourceMessageId: string,
  now: Date,
  model = "deepseek-v4-flash",
  // Derived from the text and the day when not given, so a caller that does not
  // know about report kinds (the admin reprocess scripts) still gets the same
  // answer as the live path. See reports/kind.ts.
  reportKind: ReportKind = reportKindFor(reportText, reportingDayFor(now), sender),
): Promise<ReportOutcome> {
  const budgetStatus = await getCurrentBudgetStatus(db, now);
  const redaction = await redactForLlm(db, reportText);

  const reportingDayLabel = formatCalendarDay(reportingDayFor(now));
  const candidateLimit = maxTaskCandidatesFor(budgetStatus);
  const generalTasks = (await Promise.all([listTasksByStatus(db, "active"), listTasksByStatus(db, "in_progress")])).flat();
  // The sender's own tasks first, then plan tasks due today, then the general
  // few — see buildExtractionCandidates. Under a budget limit only the first group.
  const candidates = await buildExtractionCandidates(db, {
    senderId: sender.memberId,
    reportingDay: reportingDayLabel,
    budgetStatus,
    generalLimit: candidateLimit,
    generalTasks,
  });

  // Always non-thinking (§4.5 item 3 default) — ambiguity-triggered escalation to thinking
  // mode isn't implemented yet, so isThinkingModeAllowed() isn't consulted here at all.
  // MUST be passed explicitly: live-verified 2026-08-07 that deepseek-v4-flash reasons by
  // default unless told otherwise (see client.ts's LlmCallParams.thinkingMode doc comment).
  const thinkingMode = false;

  let result;
  try {
    result = await callLlmForJson(llm, {
      model,
      systemPrompt: REPORT_EXTRACTION_SYSTEM_PROMPT,
      userContent: buildReportUserContent(redaction.text, candidates),
      schema: ReportExtractionSchema,
      thinkingMode,
      // 1024 was too tight for a long multi-item report: the model hits
      // the ceiling mid-object, the truncated text isn't parseable, and
      // every repair attempt truncates again — a deterministic failure
      // that looks like model flakiness. Output tokens are billed per
      // token generated, not per ceiling (live-verified 2026-08-10: a
      // request with max_tokens 10000 answering "{\"ok\":true}" billed 5
      // completion tokens), so this ceiling costs nothing on the normal
      // short reports and only ever binds on a genuinely long one.
      //
      // Owner's call, deliberately above the brief's §3.6.1 "conservative
      // maximum output tokens" guidance: truncation silently losing a real
      // member's report is the worse failure. The ceiling is a backstop
      // against a runaway generation, not the cost control — that job
      // belongs to llm/budget.ts's soft/hard monthly limits.
      maxOutputTokens: 10_000,
    });
  } catch (error) {
    // Found live 2026-08-08: DeepSeek exhausted 3 repair attempts on an
    // otherwise-normal report (missing the required `noActivity` field) —
    // the message was silently dropped, no ack, no error visible to the
    // sender. isAlreadyProcessed() is keyed on this exact messageId
    // (marked before this call), so it can never be retried automatically
    // — the sender has to resend as a new message. Scoped to exactly this
    // call (not a catch-all in server.ts) so a DB blip on an unrelated
    // casual message doesn't also trigger a "your report failed" reply.
    //
    // 2026-08-10: this catch was `catch {}` — it discarded the reason AND
    // the tokens the failed attempts burned, so "gangguan teknis" replies
    // were undiagnosable and their cost invisible. Both are recorded now.
    const detail = error instanceof LlmCallError ? error.detail : null;
    await recordFailedInvocation(db, {
      feature: "report_extraction",
      model,
      thinkingMode,
      promptTokens: detail?.promptTokens ?? 0,
      completionTokens: detail?.completionTokens ?? 0,
      retryCount: detail ? Math.max(detail.attempts - 1, 0) : 0,
      failureReason: detail?.lastFailureReason ?? (error instanceof Error ? error.message : String(error)),
    });
    return { status: "report_extraction_failed", memberName: sender.preferredName, retryable: isGatewayUnreachable(error) };
  }

  await recordInvocation(db, {
    feature: "report_extraction",
    model,
    thinkingMode,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    retryCount: result.retryCount,
  });

  const report = await getOrCreateDailyReport(db, sender.memberId, reportingDayLabel, reportKind);

  if (result.data.noActivity) {
    await addRevision(db, report.reportId, reportText, sourceMessageId);
    await markNoActivity(db, report.reportId);
    // The corrected report has no items: whatever it superseded can no longer be answered.
    await mergePendingReportMatch(db, sender.memberId, report.reportId, [], now);
    return { status: "report_no_activity", reportId: report.reportId, memberName: sender.preferredName };
  }

  // A member correcting an earlier "tidak ada aktivitas" with real work:
  // the flag has to come off or the date tab keeps rendering the old claim
  // and hides everything below (audit finding, 2026-09-08).
  if (report.noActivity) {
    await clearNoActivity(db, report.reportId);
  }

  const revision = await addRevision(db, report.reportId, reportText, sourceMessageId);

  // Redaction was one-way, so every [MEMBER:id]/[PROJECT:id] token the
  // model echoed back was stored verbatim — five activities read "Bantuin
  // bang [MEMBER:ff2883ed-...]" in the database and in the Sheets date tab
  // (found 2026-08-29). The ids are ours and the lookup is local, so the
  // names go back in before anything is written. Never applied to text on
  // its way OUT to the model.
  const restoreDictionary = await buildRestoreDictionary(db);
  const restore = (value: string) => restoreEntities(value, restoreDictionary);

  // Loaded ONCE per report rather than per item: a report has a handful
  // of items and the project list is small, but this runs on every
  // incoming report and the terms cannot change mid-report.
  const projectTerms = await loadProjectTerms(db);

  // Every plan-related item of this report, in report order; numbered after
  // the loop (mergePendingReportMatch) so the numbers continue after any
  // question still open from an earlier report.
  const linkedEntries: Array<{ itemId: string; activity: string; taskId: string; planRef: string; title: string; sourceReference: string | null }> = [];
  const questionEntries: Array<{ itemId: string; activity: string; taskId: string; planRef: string; flagId: string; title: string; sourceReference: string | null }> = [];
  let planDoneItems = 0;
  let anyPlanMatch = false;
  let firstItem: { itemId: string; activity: string } | null = null;

  for (const item of result.data.items) {
    // Restored ONCE, then used for everything downstream. Matching and
    // candidate titles must see the same text that gets stored, or a task
    // created today ("Bantuin bang [MEMBER:ff2883ed-...]") could never
    // match the same activity reported tomorrow.
    const activity = restore(item.activity);
    let taskId: string | undefined;

    let matched: Task | null = item.matchedTaskId ? await getTask(db, item.matchedTaskId) : null;
    let exactTitle = false;
    if (!matched) {
      matched = await findTaskByNormalizedTitle(db, activity);
      exactTitle = matched !== null;
    }

    // A match on a master-plan task takes its own path: the plan, not a
    // report, owns that task's status, and the model's confidence decides
    // whether to link now or ask the reporter first.
    let planCtx: PlanContext | null = null;
    let askFirst = false;
    if (matched) {
      planCtx = await loadPlanContext(db, matched);
      if (!planCtx) {
        taskId = matched.taskId;
      } else {
        // A revised report must not re-ask, or re-link, what the reporter
        // already answered for this report: a "bukan" (or a link they undid)
        // stays rejected even if the model is now sure, a "ya" stays confirmed.
        const earlier = await findFlag(db, report.reportId, FLAG_LOW_CONFIDENCE, planCtx.planRef);
        if (earlier?.state === "rejected") {
          planCtx = null;
        } else {
          // An exact normalized-title match is as sure as a match gets. Otherwise
          // only an explicit "high" counts: a missing or odd value reads as "low".
          const confident = exactTitle || item.matchConfidence === "high" || earlier?.state === "confirmed";
          if (confident) taskId = planCtx.task.taskId;
          else askFirst = true;
        }
      }
    }

    // Attribute the item to a project so the sheet's Proyek column is
    // filled for new reports too — the 2026-08-31 backfill only covered
    // history, so every item ingested after it was landing with a NULL
    // project_id and the column went blank again from that day on.
    //
    // A resolved task wins over the text: the task's project has been
    // through a human, the text match has not. matchProjectInText
    // returns null the moment two projects are named, so an ambiguous
    // item stays NULL and reaches the owner as a question rather than a
    // guess (owner, 2026-08-31: link only what you are sure of).
    let projectId: string | undefined;
    if (taskId) {
      const task = await getTask(db, taskId);
      if (task?.projectId) projectId = task.projectId;
    }
    if (!projectId) {
      const haystack = [activity, item.result ? restore(item.result) : "", item.obstacle ? restore(item.obstacle) : ""].join(" ");
      projectId = matchProjectInText(haystack, projectTerms)?.projectId;
    }

    const reportItem = await addReportItem(db, revision.revisionId, {
      activity,
      ...(item.result ? { result: restore(item.result) } : {}),
      ...(item.obstacle ? { obstacle: restore(item.obstacle) } : {}),
      ...(item.obstacleCategory ? { obstacleCategory: item.obstacleCategory } : {}),
      status: item.status,
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    firstItem ??= { itemId: reportItem.itemId, activity };

    if (planCtx && taskId) {
      // Linked plan task: contribution recorded, status deliberately NOT applied.
      await claimTask(db, taskId, sender.memberId);
      anyPlanMatch = true;
      linkedEntries.push({
        itemId: reportItem.itemId,
        activity,
        taskId,
        planRef: planCtx.planRef,
        title: planCtx.task.title,
        sourceReference: planCtx.task.sourceReference,
      });
      if (item.status === "done") planDoneItems++;
      await raisePlanFlags(db, planCtx, {
        itemId: reportItem.itemId,
        revisionId: revision.revisionId,
        reportId: report.reportId,
        memberId: sender.memberId,
        memberName: sender.preferredName,
        reportingDay: reportingDayLabel,
        activity,
        status: item.status,
        obstacle: reportItem.obstacle,
      });
    } else if (planCtx && askFirst) {
      // Unsure: leave the item unlinked, record why, and ask the reporter.
      anyPlanMatch = true;
      const reason = item.matchReason?.trim() ? restore(item.matchReason.trim()).slice(0, 200) : null;
      const { flag } = await raiseFlag(db, {
        itemId: reportItem.itemId,
        revisionId: revision.revisionId,
        reportId: report.reportId,
        memberId: sender.memberId,
        taskId: planCtx.task.taskId,
        kind: FLAG_LOW_CONFIDENCE,
        detail: {
          planRef: planCtx.planRef,
          planId: planCtx.planId,
          taskId: planCtx.task.taskId,
          activity,
          reason,
          note: `Laporan "${activity.slice(0, 80)}" mungkin terkait step ${planCtx.planId}, tapi belum pasti${reason ? ` (${reason})` : ""}. Menunggu konfirmasi pelapor.`,
        },
      });
      questionEntries.push({
        itemId: reportItem.itemId,
        activity,
        taskId: planCtx.task.taskId,
        planRef: planCtx.planRef,
        flagId: flag.flagId,
        title: planCtx.task.title,
        sourceReference: planCtx.task.sourceReference,
      });
    } else if (taskId) {
      await claimTask(db, taskId, sender.memberId);
      await applyReportStatusToTask(db, taskId, item.status, sender.memberId);
    } else if (CANDIDATE_TASKS_ENABLED) {
      await createCandidateTask(db, {
        reportItemId: reportItem.itemId,
        createdByMemberId: sender.memberId,
        suggestedTitle: activity,
      });
    }
  }

  // Every plan-related item — the sure links and the questions — gets a number
  // the reporter can answer with ("@helper 2 ya 3 bukan"). They MERGE into a
  // report_match the member still has open (dropping items a revision
  // superseded); a pending query confirmation is replaced, as before.
  const numbered = await mergePendingReportMatch(
    db,
    sender.memberId,
    report.reportId,
    [
      ...linkedEntries.map((e): Omit<ReportMatchItem, "n"> => ({ itemId: e.itemId, taskId: e.taskId, planRef: e.planRef, flagId: null, state: "linked" })),
      ...questionEntries.map((e): Omit<ReportMatchItem, "n"> => ({ itemId: e.itemId, taskId: e.taskId, planRef: e.planRef, flagId: e.flagId, state: "question" })),
    ],
    now,
  );
  const planLinked: PlanAckData["linked"] = linkedEntries.map((e, i) => ({
    n: numbered[i]!.n,
    activity: e.activity,
    title: e.title,
    sourceReference: e.sourceReference,
  }));
  const planQuestions: PlanAckData["questions"] = questionEntries.map((e, i) => ({
    n: numbered[linkedEntries.length + i]!.n,
    activity: e.activity,
    task: { title: e.title, sourceReference: e.sourceReference },
  }));

  // Someone with plan steps scheduled for today who reported none of them.
  // Skipped for an overtime report: it sits beside the regular report of the
  // same day, which is where today's plan work would be reported.
  if (!anyPlanMatch && firstItem && reportKind !== "overtime") {
    await raiseNoUrgentWorkFlag(db, {
      firstItem: {
        itemId: firstItem.itemId,
        revisionId: revision.revisionId,
        reportId: report.reportId,
        memberId: sender.memberId,
        memberName: sender.preferredName,
        reportingDay: reportingDayLabel,
        activity: firstItem.activity,
      },
    });
  }

  const counted = summarizeRevision(await listItemsForRevision(db, revision.revisionId));
  // Two of the counts would mislead for plan work. An item awaiting the
  // reporter's answer is not a proposed new task, and a plan task reported
  // "selesai" is not marked done here — the plan decides that.
  const summary: ReportSummary = {
    ...counted,
    taskDoneCount: Math.max(0, counted.taskDoneCount - planDoneItems),
  };
  const planAck: PlanAckData | undefined =
    planLinked.length > 0 || planQuestions.length > 0 ? { linked: planLinked, questions: planQuestions } : undefined;

  return {
    status: "report_processed",
    reportId: report.reportId,
    summary,
    memberName: sender.preferredName,
    overtime: reportKind === "overtime",
    ...(planAck ? { plan: planAck } : {}),
  };
}

/**
 * ARCHITECTURE_PROPOSAL.md §4 data flow, end to end for the report path:
 * dedup -> store raw + replay check -> resolve sender -> deterministic
 * header pre-filter -> redact -> LLM extract -> Zod validate -> deterministic
 * task match/candidate creation -> persist -> audit (via the services'
 * own event/history tables) -> return an outcome the caller sends back to
 * WhatsApp. The non-report path (queries, casual messages) is not yet
 * implemented — see README's Phase 2 status.
 */
/**
 * Whether the extraction failed because we could not get an answer out of
 * the gateway at all.
 *
 * A raw error means fetch itself threw — DNS, connection refused, the
 * gateway container down. An LlmCallError carrying an availability status
 * means it answered, but with one the client already retried twice and
 * gave up on. Everything else — 400/401/422, or a schema that never
 * validated — is about this particular message and will fail the same way
 * however often it is repeated.
 */
function isGatewayUnreachable(error: unknown): boolean {
  if (!(error instanceof LlmCallError)) return true;
  return /^http (408|429|5\d\d)/.test(error.detail.lastFailureReason);
}

/** Equal apart from line-end whitespace and leading/trailing blank space — the ways a re-sent copy of the same report differs. */
function sameReportText(a: string, b: string): boolean {
  const canon = (value: string) =>
    value
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  return canon(a) === canon(b);
}

export async function processIncomingMessage(deps: PipelineDeps, message: IncomingMessage): Promise<PipelineOutcome> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const model = deps.model ?? "deepseek-v4-flash";

  if (await isAlreadyProcessed(db, message.messageId)) {
    return { status: "duplicate" };
  }

  // incoming_messages.raw_text keeps the message EXACTLY as WhatsApp delivered
  // it (audit: what the member really sent, invisible marks included). Every
  // decision from here on — header and overtime detection, duplicate
  // detection, the LLM prompt, the stored report revision — reads `text`, the
  // normalized copy, so an invisible U+200E at the start of a line can no
  // longer make a report unrecognisable (2026-10-03, see ./normalize.ts).
  const stored = await recordIncomingMessage(db, toIncomingMessageInput(message));
  const text = normalizeIncomingText(message.text);

  if (stored.isReplayed) {
    await markProcessed(db, message.messageId);
    return { status: "replayed" };
  }

  const sender = await resolveMemberByJid(db, message.senderJid);
  if (!sender || sender.membershipStatus !== "active") {
    await markProcessed(db, message.messageId);
    // Tell an unregistered number their report did not land — but only in
    // the group, and only when the message actually looks like a report.
    //
    // Group-only is a safety line, not laziness: a direct chat from an
    // unknown number stays silent so a stranger DMing this number is never
    // told a bot is on the other end (the reason DMs were opened for the
    // owner's minutes, 2026-08-29, without answering strangers). Inside the
    // group everyone already knows the bot is a member, so nothing leaks.
    //
    // report-header-only keeps it from nagging every casual line an
    // unregistered number posts — a real member whose number changed, or a
    // new member like Rafi (2026-09-17), gets the hint exactly when they
    // tried to do the one thing the bot is for.
    const promptRegister = message.isGroup && hasReportHeader(text);
    return { status: "unrecognized_sender", promptRegister };
  }

  if (!hasReportHeader(text)) {
    // Report header wins precedence over a query mention if a message
    // somehow matched both (shouldn't happen in practice — the header
    // check already returned above when it matches).
    // A whole-message "ya"/"batal" with no @mention is read as the answer to
    // the bot's own question when that question is under 5 minutes old
    // (production 2026-10-08: a bare "Ya" was ignored). Whole-message only —
    // the per-number grammar ("2 ya") and every other text stay mention-only.
    const queryText =
      extractHelperQuery(text, message.botMentioned) ??
      ((await isBareConfirmationForPending(db, sender.memberId, text, now)) ? text.trim() : null);
    if (queryText) {
      const answer = await answerQuery(db, deps.llm, sender.memberId, queryText, now, model);
      // Same rule as the report path below: marked only once the work is
      // done, so a failure can be retried and a success is never answered
      // twice.
      await markProcessed(db, message.messageId);
      return { status: "query_answered", replyText: answer.text, ...(answer.intentSource ? { intentSource: answer.intentSource } : {}), ...(answer.attachment ? { attachment: answer.attachment } : {}) };
    }
    await storeCandidateContext(db, stored.messageId, now);
    await markProcessed(db, message.messageId);
    // Never stay silent on something that was meant as a report but was not
    // recorded. Same rule for the group and for a direct chat: reports are
    // accepted in both, so both get told. A message addressed to the bot (the
    // query branch above) is never treated as a failed report.
    if (looksLikeReportAttempt(text)) return { status: "report_not_recorded" };
    return { status: "stored_as_context" };
  }

  // Overtime is decided here, before the report is stored, and never by the
  // model: it changes which report (regular or lembur) the work lands in.
  const reportingDay = reportingDayFor(now);
  const reportKind = reportKindFor(text, reportingDay, sender);

  // The same text again is not a revision: members re-send a report when they
  // are unsure it landed. Detected before any LLM call (so it costs nothing)
  // and answered, so they stop re-sending. Compared on normalized text, so an
  // earlier copy that differs only by invisible marks still counts.
  const existing = await getDailyReport(db, sender.memberId, formatCalendarDay(reportingDay), reportKind);
  const latest = existing ? await getLatestRevision(db, existing.reportId) : null;
  // (A redelivery of the SAME message that failed half-way is not a duplicate: it must be retried.)
  if (latest && existing?.sourceMessageId !== message.messageId && sameReportText(normalizeIncomingText(latest.rawText), text)) {
    await markProcessed(db, message.messageId);
    return { status: "report_unchanged" };
  }

  const outcome = await processReportContent(db, deps.llm, sender, text, message.messageId, now, model, reportKind);
  if (outcome.status === "report_extraction_failed" && outcome.retryable) {
    // Deliberately left un-processed: the gateway, not the report, is what
    // failed. A redelivery after reconnect gets another attempt instead of
    // being swallowed as a duplicate.
    return outcome;
  }
  // Marked processed only once the report is actually stored.
  //
  // It used to be marked immediately after recordIncomingMessage, which
  // meant any failure below — an LLM error, a database error, a lost race
  // on daily_reports — left the message flagged as handled. Baileys
  // redelivering the same event on reconnect then hit the dedup check and
  // returned "duplicate", so the report was permanently gone and nothing
  // said so. The member's only recourse was to notice and retype it.
  //
  // The dedup guarantee people actually rely on is "an LLM call is never
  // paid for twice", and that still holds: a redelivery only re-enters
  // processing when the previous attempt did not finish. Reaching this
  // line means it did.
  await markProcessed(db, message.messageId);
  return outcome;
}
