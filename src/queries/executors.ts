import { and, eq, ilike } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { taskAssignees, tasks } from "../db/schema.ts";
import type { Task } from "../tasks/types.ts";
import { assignMember, createTask, listTasksByStatus } from "../tasks/service.ts";
import { classifyOpenTasksByDeadline } from "../jobs/deadline-reminders.ts";
import { listMissingReporters } from "../jobs/report-reminders.ts";
import { getMember, resolveMembersByNameOrAlias } from "../members/service.ts";
import type { Member } from "../members/types.ts";
import { cancelAvailability, setAvailability, type AvailabilityKind } from "../members/availability.ts";
import { canCheckInOvertime, canCreateTaskViaChat, canExportDailyReport, canSetAvailability } from "../permissions/engine.ts";
import { resolveProjectsByNameOrAlias } from "../projects/service.ts";
import type { Project } from "../projects/types.ts";
import { findOpenOvertimeReport, getDailyReport, getLatestRevision, getOrCreateDailyReport, listItemsForRevision, listOvertimeReporters, setOvertimeTimes } from "../reports/service.ts";
import type { ReportItem } from "../reports/types.ts";
import { addCalendarDays, calendarDayOf, formatCalendarDay, overtimeCheckinDayFor, reportingDayFor, type CalendarDay } from "../shared/time.ts";
import { buildDailyWorkbook } from "../export/daily-workbook.ts";
import type { QueryIntent } from "../llm/schemas.ts";

/**
 * MASTER_SPEC.md §16: "The LLM parses intent and parameters. The backend
 * executes authorized database queries. Do not answer operational
 * questions from LLM memory." One function per intent, all deterministic
 * — this module composes existing services, it doesn't invent new query
 * logic where a service already exists (tasks_today/nearest_deadline/
 * missing_reporters/stale_tasks reuse the exact functions the scheduled
 * jobs already use, so a query answer and the morning summary can never
 * silently disagree).
 *
 * Name/project resolution is always "exactly one match or ask" — 0 or
 * >1 matches never guesses, matching the same convention already used
 * for report-item task/project matching elsewhere in this codebase.
 */

export type QueryResult =
  | { kind: "tasks_today"; dueToday: Task[] }
  | { kind: "nearest_deadline"; h3: Task[]; h1: Task[]; dueToday: Task[]; overdue: Task[] }
  | { kind: "member_tasks"; member: Member; tasks: Task[]; scheduledFor: string | null }
  | { kind: "member_not_found"; searchText: string; candidates: Member[] }
  | { kind: "missing_reporters"; members: Member[] }
  | { kind: "task_status"; task: Task }
  | { kind: "task_not_found"; searchText: string; candidates: Task[] }
  | { kind: "member_report"; member: Member; reportingDay: string; items: ReportItem[]; noActivity: boolean; noReport: boolean }
  | { kind: "stale_tasks"; tasks: Task[] }
  | { kind: "project_summary"; project: Project; tasks: Task[] }
  | { kind: "project_not_found"; searchText: string; candidates: Project[] }
  | { kind: "overtime_today"; day: string; reporters: Array<{ preferredName: string; startText: string | null; endText: string | null }> }
  | { kind: "overtime_checked_in"; day: string; alreadyReported: boolean; startText: string | null }
  | { kind: "overtime_checked_out"; day: string; endText: string | null }
  | { kind: "overtime_checkin_denied" }
  | { kind: "task_created"; task: Task; assignees: Member[]; scheduledFor: string | null }
  | { kind: "task_create_denied" }
  | { kind: "task_create_needs_title" }
  | { kind: "task_create_unresolved_names"; names: string[] }
  | { kind: "daily_report_export"; day: string; fileName: string; content: Buffer; rowCount: number }
  | { kind: "daily_report_export_denied" }
  | { kind: "daily_report_export_empty"; day: string }
  | { kind: "availability_set"; member: Member; availabilityKind: AvailabilityKind; days: string[]; reason: string | null }
  | { kind: "availability_cancelled"; member: Member; days: string[] }
  | { kind: "availability_nothing_to_cancel"; member: Member; days: string[] }
  | { kind: "availability_missing_kind" }
  | { kind: "availability_denied" }
  | { kind: "unknown" };

async function resolveMemberCandidates(db: AppDatabase, name: string | null | undefined): Promise<Member[]> {
  if (!name) return [];
  return resolveMembersByNameOrAlias(db, name);
}

async function tasksForMember(db: AppDatabase, memberId: string, scheduledFor: string | null = null): Promise<Task[]> {
  const rows = await db
    .select({ task: tasks })
    .from(taskAssignees)
    .innerJoin(tasks, eq(taskAssignees.taskId, tasks.taskId))
    .where(
      scheduledFor
        ? and(eq(taskAssignees.memberId, memberId), eq(tasks.scheduledFor, scheduledFor))
        : eq(taskAssignees.memberId, memberId),
    );
  return rows.map((r) => r.task);
}

async function findTasksByTitleContains(db: AppDatabase, text: string): Promise<Task[]> {
  return db.select().from(tasks).where(ilike(tasks.title, `%${text}%`));
}

/**
 * The actor is the sender of the @helper message — needed only by
 * set_availability, the one mutating intent (see permissions/engine.ts's
 * canSetAvailability: self always, others admin-only).
 */
export async function executeQuery(db: AppDatabase, intent: QueryIntent, now: Date, actorMemberId: string): Promise<QueryResult> {
  switch (intent.intent) {
    case "tasks_today": {
      const groups = await classifyOpenTasksByDeadline(db, now);
      return { kind: "tasks_today", dueToday: groups.dueToday };
    }
    case "nearest_deadline": {
      const groups = await classifyOpenTasksByDeadline(db, now);
      return { kind: "nearest_deadline", ...groups };
    }
    case "member_tasks": {
      const list = await resolveMemberCandidates(db, intent.targetMemberName);
      if (list.length !== 1) return { kind: "member_not_found", searchText: intent.targetMemberName ?? "", candidates: list };
      const member = list[0];
      if (!member) return { kind: "member_not_found", searchText: intent.targetMemberName ?? "", candidates: [] };
      // dayOffset present means the question named a day ("besok"), so
      // only work scheduled for that day answers it. Absent means "what is
      // this person holding at all", which is the original behaviour.
      const scheduledFor = intent.dayOffset === null || intent.dayOffset === undefined
        ? null
        : formatCalendarDay(addCalendarDays(calendarDayOf(now), intent.dayOffset));
      return { kind: "member_tasks", member, tasks: await tasksForMember(db, member.memberId, scheduledFor), scheduledFor };
    }
    case "missing_reporters":
      return { kind: "missing_reporters", members: await listMissingReporters(db, now) };
    case "task_status": {
      if (!intent.taskReference) return { kind: "task_not_found", searchText: "", candidates: [] };
      const matches = await findTasksByTitleContains(db, intent.taskReference);
      if (matches.length !== 1) return { kind: "task_not_found", searchText: intent.taskReference, candidates: matches };
      const task = matches[0];
      if (!task) return { kind: "task_not_found", searchText: intent.taskReference, candidates: [] };
      return { kind: "task_status", task };
    }
    case "member_report": {
      const list = await resolveMemberCandidates(db, intent.targetMemberName);
      if (list.length !== 1) return { kind: "member_not_found", searchText: intent.targetMemberName ?? "", candidates: list };
      const member = list[0];
      if (!member) return { kind: "member_not_found", searchText: intent.targetMemberName ?? "", candidates: [] };

      const day = addCalendarDays(reportingDayFor(now), intent.dayOffset ?? 0);
      const reportingDayLabel = formatCalendarDay(day);
      const report = await getDailyReport(db, member.memberId, reportingDayLabel);
      if (!report) return { kind: "member_report", member, reportingDay: reportingDayLabel, items: [], noActivity: false, noReport: true };
      if (report.noActivity) return { kind: "member_report", member, reportingDay: reportingDayLabel, items: [], noActivity: true, noReport: false };

      const revision = await getLatestRevision(db, report.reportId);
      const items = revision ? await listItemsForRevision(db, revision.revisionId) : [];
      return { kind: "member_report", member, reportingDay: reportingDayLabel, items, noActivity: false, noReport: false };
    }
    case "stale_tasks":
      return { kind: "stale_tasks", tasks: await listTasksByStatus(db, "stale") };
    case "project_summary": {
      if (!intent.projectReference) return { kind: "project_not_found", searchText: "", candidates: [] };
      const matches = await resolveProjectsByNameOrAlias(db, intent.projectReference);
      if (matches.length !== 1) return { kind: "project_not_found", searchText: intent.projectReference, candidates: matches };
      const project = matches[0];
      if (!project) return { kind: "project_not_found", searchText: intent.projectReference, candidates: [] };
      const projectTasks = await db.select().from(tasks).where(and(eq(tasks.projectId, project.projectId)));
      return { kind: "project_summary", project, tasks: projectTasks };
    }
    case "overtime_today": {
      // The same day a check-in right now would land on, so "siapa yang lembur"
      // at 09:30 shows the people who just checked in this morning.
      const dayLabel = formatCalendarDay(overtimeCheckinDayFor(now));
      const reporters = await listOvertimeReporters(db, dayLabel);
      return { kind: "overtime_today", day: dayLabel, reporters };
    }
    case "overtime_checkin": {
      const actor = await getMember(db, actorMemberId);
      if (!actor || !canCheckInOvertime(actor)) return { kind: "overtime_checkin_denied" };

      // Evening and after-midnight check-ins use the reporting day (checking
      // in at 23:30 means the working day whose reports are still open); a
      // morning one (05:00-09:59) means working TODAY, so it uses the calendar
      // day. `now` is the time of the ORIGINAL message even when the member
      // confirms later (see answerQuery) — a "ya" at 10:01 must not shift it.
      const dayLabel = formatCalendarDay(overtimeCheckinDayFor(now));
      // Opens the overtime report so the check-in is visible and can be
      // nagged if no lembur work follows — the date tab renders an
      // item-less overtime report as "lembur — belum lapor". Idempotent:
      // tapping twice does not make a second report.
      const report = await getOrCreateDailyReport(db, actor.memberId, dayLabel, "overtime");
      const startText = intent.timeText?.trim() || null;
      if (startText) await setOvertimeTimes(db, report.reportId, { startText });
      const revision = await getLatestRevision(db, report.reportId);
      const items = revision ? await listItemsForRevision(db, revision.revisionId) : [];
      return { kind: "overtime_checked_in", day: dayLabel, alreadyReported: items.length > 0, startText };
    }
    case "overtime_checkout": {
      const actor = await getMember(db, actorMemberId);
      if (!actor || !canCheckInOvertime(actor)) return { kind: "overtime_checkin_denied" };

      // Attach the stop to the report it belongs to: the member's most recent
      // open overtime report from the last 18 hours (so a 00:30 or 09:30
      // checkout lands on the evening's report, not on a day the clock
      // suggests). Only without one is a report opened for the reporting day,
      // so someone who only says "selesai lembur jam 9" still gets a recorded stop.
      const open = await findOpenOvertimeReport(db, actor.memberId, now);
      const dayLabel = open ? open.reportingDay : formatCalendarDay(reportingDayFor(now));
      const report = open ?? (await getOrCreateDailyReport(db, actor.memberId, dayLabel, "overtime"));
      const endText = intent.timeText?.trim() || null;
      if (endText) await setOvertimeTimes(db, report.reportId, { endText });
      return { kind: "overtime_checked_out", day: dayLabel, endText };
    }
    case "create_task": {
      const actor = await getMember(db, actorMemberId);
      if (!actor || !canCreateTaskViaChat(actor)) return { kind: "task_create_denied" };

      const title = intent.taskTitle?.trim();
      if (!title) return { kind: "task_create_needs_title" };

      // Every name resolves to exactly one member, or nothing is created.
      //
      // Refusing the WHOLE request rather than creating the task and
      // attaching whoever happened to resolve: a task that silently landed
      // on one of the two people named is worse than no task, because the
      // admin sees a confirmation and stops thinking about it while the
      // other person was never told.
      const names = intent.targetMemberNames ?? (intent.targetMemberName ? [intent.targetMemberName] : []);
      const assignees: Member[] = [];
      const unresolved: string[] = [];
      for (const name of names) {
        const matches = await resolveMemberCandidates(db, name);
        if (matches.length === 1 && matches[0]) assignees.push(matches[0]);
        else unresolved.push(name);
      }
      if (unresolved.length > 0) return { kind: "task_create_unresolved_names", names: unresolved };

      // The scheduled day, not a deadline: "besok" says when the work
      // happens. Absent dayOffset means unscheduled rather than today —
      // an admin who did not name a day did not mean today.
      const scheduledDay = intent.dayOffset === null || intent.dayOffset === undefined
        ? null
        : addCalendarDays(calendarDayOf(now), intent.dayOffset);
      const scheduledFor = scheduledDay ? formatCalendarDay(scheduledDay) : null;

      let projectId: string | undefined;
      if (intent.projectReference) {
        const matches = await resolveProjectsByNameOrAlias(db, intent.projectReference);
        if (matches.length === 1 && matches[0]) projectId = matches[0].projectId;
      }

      const task = await createTask(db, {
        title,
        createdByMemberId: actor.memberId,
        sourceReference: "chat",
        ...(projectId ? { projectId } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      });
      for (const assignee of assignees) await assignMember(db, task.taskId, assignee.memberId);

      return { kind: "task_created", task, assignees, scheduledFor };
    }
    case "export_daily_report": {
      const actor = await getMember(db, actorMemberId);
      if (!actor || !canExportDailyReport(actor)) return { kind: "daily_report_export_denied" };

      // The reporting day, not the calendar day: §14 says today runs until
      // 09:59 tomorrow, so an admin asking at 23:30 for "hari ini" means
      // the day whose reports are still arriving.
      const day = addCalendarDays(reportingDayFor(now), intent.dayOffset ?? 0);
      const workbook = await buildDailyWorkbook(db, day);
      // Refused when nobody has actually reported. Not when the grid is
      // empty — a day with no reports still renders one "belum lapor" row
      // per active member, and forwarding that tells the boss's assistant
      // the division did nothing, when the truth is the reports have not
      // arrived yet.
      if (workbook.reportCount === 0) return { kind: "daily_report_export_empty", day: formatCalendarDay(day) };

      return {
        kind: "daily_report_export",
        day: formatCalendarDay(day),
        fileName: workbook.fileName,
        content: workbook.buffer,
        rowCount: workbook.rowCount,
      };
    }
    case "set_availability": {
      if (!intent.availabilityKind) return { kind: "availability_missing_kind" };

      const resolution = await resolveAvailabilityTarget(db, intent, actorMemberId);
      if (resolution.blocked) return resolution.blocked;

      const days = availabilityDaysFor(intent, now);
      // Trimmed to null rather than stored as "": an empty string reads as
      // "a reason was given" everywhere downstream, which is worse than
      // plainly having none.
      const reason = intent.availabilityReason?.trim() || null;
      // One row per day, not a range: §15 keeps a declaration to a single
      // calendar day, and the same reason applies to each of them.
      for (const day of days) {
        await setAvailability(db, resolution.target.memberId, intent.availabilityKind, day, reason ?? undefined);
      }
      return {
        kind: "availability_set",
        member: resolution.target,
        availabilityKind: intent.availabilityKind,
        days: days.map(formatCalendarDay),
        reason,
      };
    }
    case "cancel_availability": {
      const resolution = await resolveAvailabilityTarget(db, intent, actorMemberId);
      if (resolution.blocked) return resolution.blocked;

      const days = availabilityDaysFor(intent, now);
      const cancelled: CalendarDay[] = [];
      for (const day of days) {
        if ((await cancelAvailability(db, resolution.target.memberId, day, resolution.actor.memberId, now)) > 0) cancelled.push(day);
      }
      // Distinguishing "retracted N" from "there was nothing there" matters:
      // silently answering "cancelled" when no declaration existed would let
      // someone believe a leave they never successfully recorded is now gone.
      // With several days asked for, the answer names the days actually
      // retracted rather than the days requested.
      return cancelled.length > 0
        ? { kind: "availability_cancelled", member: resolution.target, days: cancelled.map(formatCalendarDay) }
        : { kind: "availability_nothing_to_cancel", member: resolution.target, days: days.map(formatCalendarDay) };
    }
    default:
      return { kind: "unknown" };
  }
}

/**
 * The declared day uses the CALENDAR day, not the reporting day: a member
 * saying "saya sakit hari ini" at 08:00 means the workday about to start,
 * not the reporting day still closing from yesterday. The paired CHECK
 * (jobs/report-reminders.ts) keys off the reporting day instead — see the
 * doc comments there and in members/availability.ts for why that
 * combination is what §14 actually describes.
 */
/**
 * Every calendar day one declaration covers, in order, without duplicates.
 *
 * Two sources, because members write both in one sentence ("Besok izin gak
 * masuk ... begitu juga di tanggal 12,19,26 mendatang"): a relative offset,
 * and bare day-of-month numbers. Before 2026-09-04 only the offset existed
 * and everything after "besok" in that message was dropped in silence.
 *
 * A bare number resolves to its NEXT occurrence at or after today, which is
 * what "tanggal 12 mendatang" means on the 4th and still means on the 20th
 * (then it is next month's 12th). The arithmetic lives here rather than in
 * the prompt on purpose — the model reports the number it read, the backend
 * decides which day that is.
 *
 * Note this uses the calendar day, not the reporting day: §14's rule is
 * that DECLARING is about the workday being spoken of, not about the
 * reporting window still closing from yesterday.
 */
function availabilityDaysFor(intent: QueryIntent, now: Date): CalendarDay[] {
  const today = calendarDayOf(now);
  const days: CalendarDay[] = [addCalendarDays(today, intent.dayOffset ?? 0)];

  for (const dayOfMonth of intent.additionalDayOfMonths ?? []) {
    days.push(nextOccurrenceOfDayOfMonth(today, dayOfMonth));
  }

  const seen = new Set<string>();
  return days
    .filter((day) => {
      const key = formatCalendarDay(day);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => formatCalendarDay(a).localeCompare(formatCalendarDay(b)));
}

/**
 * The first day numbered `dayOfMonth` that is not in the past. Walks
 * forward a day at a time rather than doing month arithmetic: a month can
 * lack the 31st, and stepping past it lands on the next month that has one
 * without any special cases. Bounded at 400 days so a nonsense number can
 * never spin.
 */
function nextOccurrenceOfDayOfMonth(today: CalendarDay, dayOfMonth: number): CalendarDay {
  let cursor = today;
  for (let guard = 0; guard < 400; guard++) {
    if (cursor.day === dayOfMonth) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  return today;
}

type AvailabilityTargetResolution =
  | { blocked: QueryResult; target?: undefined; actor?: undefined }
  | { blocked: null; target: Member; actor: Member };

/** Shared by set/cancel: resolve who the declaration is about, then check §14's self-or-admin rule. */
async function resolveAvailabilityTarget(
  db: AppDatabase,
  intent: QueryIntent,
  actorMemberId: string,
): Promise<AvailabilityTargetResolution> {
  const actor = await getMember(db, actorMemberId);
  if (!actor) return { blocked: { kind: "unknown" } };

  let target = actor;
  if (intent.targetMemberName) {
    const list = await resolveMemberCandidates(db, intent.targetMemberName);
    if (list.length !== 1) {
      return { blocked: { kind: "member_not_found", searchText: intent.targetMemberName, candidates: list } };
    }
    const resolved = list[0];
    if (!resolved) {
      return { blocked: { kind: "member_not_found", searchText: intent.targetMemberName, candidates: [] } };
    }
    target = resolved;
  }

  const permissionActor = { memberId: actor.memberId, role: actor.role, membershipStatus: actor.membershipStatus };
  if (!canSetAvailability(permissionActor, target.memberId)) return { blocked: { kind: "availability_denied" } };

  return { blocked: null, target, actor };
}
