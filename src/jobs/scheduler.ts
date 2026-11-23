import PgBoss from "pg-boss";
import type { sheets_v4 } from "googleapis";
import type { AppDatabase } from "../db/types.ts";
import { detectStaleTasks } from "./stale-detection.ts";
import { redactOldRawMessageText } from "./cleanup.ts";
import { classifyOpenTasksByDeadline } from "./deadline-reminders.ts";
import { listMissingReporters } from "./report-reminders.ts";
import { buildMentionMessage, mentionToken, REPORT_REMINDER_LEAD, resolveMentionables } from "../members/mentions.ts";
import { bulletList, joinBlocks, taskLabel, titleLine } from "../format/wa.ts";
import { listAssigneesForTasks } from "../tasks/service.ts";
import { formatConflictNotice, runTasksSync } from "./sheets-sync.ts";
import { formatReportsSyncFailureNotice, runReportsSync } from "./reports-sync.ts";
import { buildWeeklySummary, persistWeeklySummary } from "./weekly-summary.ts";
import { formatPlanIdentityLog, formatPlanSyncSummary, runPlanSync, type PlanSyncConfig } from "../plan/run.ts";
import { composeMorningBrief, persistMorningBrief } from "../brief/morning-brief.ts";
import type { BriefLlmDeps } from "../brief/llm.ts";
import { composeWeeklyRecap, persistWeeklyRecap, recapWeekStartFor } from "../recap/weekly.ts";

/**
 * MASTER_SPEC.md §11/§9.4 schedule, registered against pg-boss. This file
 * is deliberately thin — the actual logic lives in the tested modules
 * above (stale-detection.ts, cleanup.ts, morning-summary.ts,
 * deadline-reminders.ts, report-reminders.ts, candidates.ts). pg-boss
 * requires LISTEN/NOTIFY and advisory locks against a real PostgreSQL
 * instance, which the PGlite in-memory database used by every other test
 * in this repo does not support — so this registration wiring is NOT
 * covered by automated tests. Verify it manually against a real Postgres
 * before relying on it in production.
 *
 * Sending the resulting content to WhatsApp (morning summary text,
 * reminder messages) is not implemented here — that needs the Baileys
 * connector (src/whatsapp/), which this file takes as an injected
 * `sendGroupText` callback so job logic and message delivery stay decoupled.
 */

export interface SheetsSyncConfig {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  /** Attributed as taskEvents.actorMemberId for admin_sheet_edit events. Nullable column — omit if there's no single "the sheets admin" member to attribute edits to. */
  adminActorMemberId?: string;
}

export interface SchedulerDeps {
  db: AppDatabase;
  boss: PgBoss;
  sendGroupText: (text: string) => Promise<void>;
  /**
   * Same message, but the named members actually get a notification.
   *
   * Optional so every existing caller and test keeps working untouched; a
   * deployment without it degrades to plain text rather than failing, which
   * is the right trade for a reminder — a reminder nobody is pinged about
   * still beats no reminder.
   */
  sendGroupMention?: (text: string, mentionedJids: string[]) => Promise<void>;
  /**
   * Optional: absent on a dev box or any environment without Sheets
   * credentials configured, same pattern as LITELLM_API_KEY being
   * optional in config/env.ts — registerScheduledJobs simply skips the
   * sync job's queue/schedule/work registration when this is undefined,
   * rather than requiring it everywhere just to boot.
   */
  sheetsSync?: SheetsSyncConfig;
  /** Optional like sheetsSync: absent unless PLAN_SPREADSHEET_ID is configured. See src/plan/. */
  planSync?: PlanSyncConfig;
  /**
   * The LLM the morning brief asks for its summary and blocker advice.
   * Optional like the rest: absent, the brief is the plain facts without the
   * model's sections.
   */
  morningBrief?: BriefLlmDeps;
}

const JOB_NAMES = {
  morningSummary: "wdh.morning-summary",
  deadlineReminder: "wdh.deadline-reminder",
  reportReminderFirst: "wdh.report-reminder-first",
  reportReminderFinal: "wdh.report-reminder-final",
  staleDetection: "wdh.stale-detection",
  candidatePromotion: "wdh.candidate-promotion",
  cleanup: "wdh.cleanup",
  sheetsSync: "wdh.sheets-sync",
  sheetsSyncFrequent: "wdh.sheets-sync-frequent",
  reportsSync: "wdh.reports-sync",
  reportsSyncEvening: "wdh.reports-sync-evening",
  weeklySummaryProvisional: "wdh.weekly-summary-provisional",
  weeklySummaryFinal: "wdh.weekly-summary-final",
  weeklyRecap: "wdh.weekly-recap",
} as const;

const JAKARTA_TZ = "Asia/Jakarta";

// Outside JOB_NAMES on purpose: that map is filtered by name to decide which
// queues always exist, and this one exists only when configured.
const PLAN_SYNC_JOB = "wdh.plan-sync";

export async function registerScheduledJobs(deps: SchedulerDeps): Promise<void> {
  const { boss, db, sendGroupText } = deps;

  // Tagging turned on 2026-09-08 at the owner's request, once the WhatsApp
  // account had warmed up enough that pinging people was not going to look
  // like automated spam to WhatsApp. Falls back to plain text wherever no
  // mention sender is wired.
  const sendGroupMention = deps.sendGroupMention ?? (async (text: string) => sendGroupText(text));

  // pg-boss v10 requires a queue to exist before schedule()/work() reference
  // it (schedule.name has a FK onto queue.name) — createQueue() is
  // idempotent (INSERT ... ON CONFLICT DO NOTHING), safe to call on every
  // boot. Found by running this against a real Postgres for the first time
  // (2026-08-07) — the fake `boss` in tests never enforced this constraint.
  // sheetsSync's and reportsSync's queues are created separately below,
  // only when configured — no point creating a queue for a job that will
  // never be scheduled.
  const alwaysOnJobNames = Object.values(JOB_NAMES).filter(
    (name) =>
      name !== JOB_NAMES.sheetsSync &&
      name !== JOB_NAMES.sheetsSyncFrequent &&
      name !== JOB_NAMES.reportsSync &&
      name !== JOB_NAMES.reportsSyncEvening,
  );
  for (const name of alwaysOnJobNames) {
    await boss.createQueue(name);
  }

  // Monday-Saturday 08:00 — §11.1
  await boss.schedule(JOB_NAMES.morningSummary, "0 8 * * 1-6", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.morningSummary, async () => {
    const now = new Date();
    const brief = await composeMorningBrief(db, deps.morningBrief ? { llm: deps.morningBrief } : {}, now);
    await sendGroupText(brief.text);
    // The brief is already out; failing to remember it must not make pg-boss
    // retry the job and send the same message twice. The cost is only that
    // tomorrow's "changes since" window falls back to its default.
    try {
      await persistMorningBrief(db, brief, now);
    } catch (error) {
      console.error("morning-brief: could not persist the brief:", error);
    }
  });

  // Daily 16:00 — §8/§11.2, only sends when there's actually a due-today task
  await boss.schedule(JOB_NAMES.deadlineReminder, "0 16 * * *", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.deadlineReminder, async () => {
    const groups = await classifyOpenTasksByDeadline(db);
    if (groups.dueToday.length === 0) return;
    // Tags the people actually holding the task, not the whole group: a
    // deadline reminder that pings 17 people to reach 2 of them is how a
    // group learns to mute the bot.
    const assignees = await listAssigneesForTasks(db, groups.dueToday.map((t) => t.taskId));
    const mentionables = await resolveMentionables(db, assignees);
    await sendGroupMention(
      `${formatDeadlineReminderText(groups.dueToday)}${mentionables.length > 0 ? `

${mentionables.map((m) => mentionToken(m.jid)).join(" ")}` : ""}`,
      mentionables.map((m) => m.jid),
    );
  });

  // Monday-Saturday 20:00 / 22:30 — §9.4
  await boss.schedule(JOB_NAMES.reportReminderFirst, "0 20 * * 1-6", {}, { tz: JAKARTA_TZ });
  await boss.schedule(JOB_NAMES.reportReminderFinal, "30 22 * * 1-6", {}, { tz: JAKARTA_TZ });
  const sendMissingReportersReminder = async () => {
    const missing = await listMissingReporters(db);
    if (missing.length === 0) return;
    const mentionables = await resolveMentionables(db, missing);
    const message = buildMentionMessage(REPORT_REMINDER_LEAD, missing, mentionables);
    await sendGroupMention(message.text, message.mentionedJids);
  };
  await boss.work(JOB_NAMES.reportReminderFirst, sendMissingReportersReminder);
  await boss.work(JOB_NAMES.reportReminderFinal, sendMissingReportersReminder);

  // Daily, before the morning summary runs
  await boss.schedule(JOB_NAMES.staleDetection, "0 6 * * *", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.staleDetection, async () => {
    await detectStaleTasks(db);
  });

  // §10 said an unanswered candidate auto-promotes after 3 morning
  // summaries. Turned OFF 2026-09-01 at the owner's decision, after the
  // rule was measured twice against real traffic:
  //
  //  - By 2026-08-31 it had produced 242 tasks, all cancelled in one go.
  //  - It ran once more on 2026-09-01 and produced 28 more, including
  //    near-duplicate pairs ("troubleshooting wiring Strobo" and
  //    "trouble shooting wiring Strobo") — dedup compares normalized
  //    titles exactly, so one typo is a second task.
  //
  // The premise was wrong, not the threshold: a daily report line is a
  // sentence about a day, not a unit of work. The 12 tasks extracted from
  // the 2026-08-31 meeting minutes had 9 moved by real reports within one
  // working day; 397 daily reports over three weeks yielded nothing worth
  // keeping. Tasks come from meetings and admins, not from activity text.
  //
  // Candidates are still CREATED and still counted — they are a real
  // signal of work nobody has turned into a task. They just no longer
  // become tasks without a human. unschedule() is what actually stops it:
  // pg-boss persists schedules in the database, so deleting the
  // schedule() call alone would leave the cron row firing into a queue
  // with no worker attached.
  await boss.unschedule(JOB_NAMES.candidatePromotion);

  // Daily, off-peak — SECURITY_AND_PRIVACY.md §8.4
  await boss.schedule(JOB_NAMES.cleanup, "0 3 * * *", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.cleanup, async () => {
    await redactOldRawMessageText(db);
  });

  // Saturday 10:15 — §15 provisional wrap-up (Monday-Friday plus
  // Saturday's initial state), persisted for the sheet only. It is no longer
  // sent to WhatsApp (ADR-0016): the Sunday recap below replaces it in the group.
  await boss.schedule(JOB_NAMES.weeklySummaryProvisional, "15 10 * * 6", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.weeklySummaryProvisional, async () => {
    const now = new Date();
    const summary = await buildWeeklySummary(db, now);
    await persistWeeklySummary(db, summary, true, now);
  });

  // Sunday 10:05 — §15 final wrap-up, after Saturday's report window
  // closes at 09:59. Recomputes and overwrites the SAME weekStart row
  // (provisional -> false). Deliberately NO WhatsApp send — §15 is
  // explicit "send no WhatsApp message" for the final run, only Sheets.
  await boss.schedule(JOB_NAMES.weeklySummaryFinal, "5 10 * * 0", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.weeklySummaryFinal, async () => {
    const now = new Date();
    const summary = await buildWeeklySummary(db, now);
    await persistWeeklySummary(db, summary, false, now);
  });

  // Sunday 19:00 — ADR-0016 weekly recap per work stream, sent to the group.
  // The week is the Monday..Sunday ending today. Same LLM as the morning brief;
  // a model failure sends the deterministic fallback, never nothing.
  await boss.schedule(JOB_NAMES.weeklyRecap, "0 19 * * 0", {}, { tz: JAKARTA_TZ });
  await boss.work(JOB_NAMES.weeklyRecap, async () => {
    const now = new Date();
    const recap = await composeWeeklyRecap(db, deps.morningBrief ? { llm: deps.morningBrief } : {}, recapWeekStartFor(now), now);
    await sendGroupText(recap.text);
    // Already sent: a failure to store must not make pg-boss retry and send it twice.
    try {
      await persistWeeklyRecap(db, recap, now);
    } catch (error) {
      console.error("weekly-recap: could not persist the recap:", error);
    }
  });

  // Hourly, not more frequent — half the API quota of every-30-min with
  // no real operational difference at this data volume (Opus design
  // review, 2026-08-08). Import runs before export in runTasksSync() so
  // the cycle ends showing DB truth including any edit just applied.
  if (deps.sheetsSync) {
    const { sheets, spreadsheetId, adminActorMemberId } = deps.sheetsSync;
    const syncTasks = async () => {
      const result = await runTasksSync(sheets, spreadsheetId, db, adminActorMemberId, new Date());
      const notice = formatConflictNotice(result.importSummary);
      if (notice) await sendGroupText(notice);
    };

    await boss.createQueue(JOB_NAMES.sheetsSync);
    await boss.schedule(JOB_NAMES.sheetsSync, "10 * * * *", {}, { tz: JAKARTA_TZ });
    await boss.work(JOB_NAMES.sheetsSync, syncTasks);

    // Every 5 minutes through the working day.
    //
    // Hourly was tolerable while TASKS was only a spreadsheet to look at.
    // It stopped being tolerable on 2026-09-08, when assigning work became
    // a conversation: an admin swapped a task's assignee in the sheet,
    // asked the bot about it a minute later, and was told the person had
    // no task — the edit was sitting in the sheet waiting up to 48 more
    // minutes. Nothing was wrong and nothing said so, which is the worst
    // shape a delay can take.
    //
    // Minutes 4,9,...,59: clear of :10 above, and clear of the 2,7,...,57
    // used by reports-sync-evening so the two never contend for the Sheets
    // quota in the same second. runTasksSync also refuses to run
    // concurrently now; this offset means it should not have to.
    await boss.createQueue(JOB_NAMES.sheetsSyncFrequent);
    await boss.schedule(JOB_NAMES.sheetsSyncFrequent, "4-59/5 8-23 * * *", {}, { tz: JAKARTA_TZ });
    await boss.work(JOB_NAMES.sheetsSyncFrequent, syncTasks);

    // Hourly, offset 20 minutes past wdh.sheets-sync so the two Sheets API
    // workloads don't collide. Found live 2026-08-10: this export
    // (MEMBERS/DAILY_REPORTS/date-tabs/WEEKLY_SUMMARIES) was built and
    // verified by hand once but never actually registered here — no date
    // tab or report row had synced automatically since, only
    // wdh.sheets-sync's TASKS-only sync was ever really running. The owner
    // caught this from the live spreadsheet, not from any test (same
    // "can't test against real Postgres/pg-boss" gap noted above).
    const syncReports = async () => {
      const result = await runReportsSync(sheets, spreadsheetId, db, new Date());
      const notice = formatReportsSyncFailureNotice(result);
      if (notice) await sendGroupText(notice);
    };

    await boss.createQueue(JOB_NAMES.reportsSync);
    await boss.schedule(JOB_NAMES.reportsSync, "30 * * * *", {}, { tz: JAKARTA_TZ });
    await boss.work(JOB_NAMES.reportsSync, syncReports);

    // Every 5 minutes through the evening, when reports actually arrive.
    //
    // Hourly alone meant a member could report and not appear in the sheet
    // for the best part of an hour. Measured 2026-09-04: Andre waited 54
    // minutes, Yanto 49, and Kurnia's report was invisible for 35 — long
    // enough for the owner to check the sheet and conclude, reasonably,
    // that it had not been recorded at all. The data was there the whole
    // time; only the sheet was behind.
    //
    // Confined to 17:00-23:59 WIB rather than running all day because
    // that is when reports land (every report over the last week arrived
    // between 17:30 and 22:30) — the rest of the day would be twelve
    // no-op syncs an hour against the Sheets quota. The hourly job above
    // still covers everything outside the window.
    //
    // Minutes 2,7,...,57 rather than 0,5,...,55: the first version used
    // the round five-minute marks, which put a tick on :30 — the same
    // minute as the hourly job above. The two ran concurrently and raced
    // inside ensureTabFormatting, producing 17 Sheets failures across
    // 2026-09-04/05 (every one of them at :30) and four "Sinkronisasi
    // Sheets gagal" messages to the division about a fault that was
    // entirely self-inflicted. runReportsSync now also refuses to run
    // concurrently; this offset means it should never have to.
    await boss.createQueue(JOB_NAMES.reportsSyncEvening);
    await boss.schedule(JOB_NAMES.reportsSyncEvening, "2-59/5 17-23 * * *", {}, { tz: JAKARTA_TZ });
    await boss.work(JOB_NAMES.reportsSyncEvening, syncReports);
  }

  // The supervisor's plan spreadsheet is the source of truth for plan tasks
  // (src/plan/). Every 15 minutes through the working day; the sheet is only
  // ever read. Minutes 3,18,33,48 stay clear of the 4-59/5 TASKS sync ticks
  // and the :30 reports sync. A failure is logged and nothing else: a plan
  // the bot could not read yet is not something to announce to the division,
  // and the next tick retries.
  if (deps.planSync) {
    const planSync = deps.planSync;
    await boss.createQueue(PLAN_SYNC_JOB);
    await boss.schedule(PLAN_SYNC_JOB, "3,18,33,48 7-22 * * *", {}, { tz: JAKARTA_TZ });
    await boss.work(PLAN_SYNC_JOB, async () => {
      try {
        const result = await runPlanSync(db, planSync, new Date(), { dryRun: false });
        if (result) {
          for (const line of formatPlanIdentityLog(result)) console.info(line);
          console.info(formatPlanSyncSummary(result));
        }
      } catch (error) {
        console.error("plan-sync failed:", error);
      }
    });
  }
}

export function formatDeadlineReminderText(dueToday: Awaited<ReturnType<typeof classifyOpenTasksByDeadline>>["dueToday"]): string {
  return joinBlocks(titleLine("⏰", "Jatuh tempo hari ini", `${dueToday.length} task`), bulletList(dueToday.map((t) => taskLabel(t))).join("\n"));
}

