import { asc, desc, inArray } from "drizzle-orm";
import { stripInlineAliases } from "../recap/llm.ts";
import type { AppDatabase } from "../db/types.ts";
import { members, dailyReports, reportRevisions, reportItems, tasks, weeklySummaries, weeklyStreamRecaps, workStreams } from "../db/schema.ts";
import { toJakartaWallClock } from "../shared/time.ts";
import type { WeeklySummary } from "../jobs/weekly-summary.ts";

/**
 * MASTER_SPEC.md §13 "public link risk": never include phone numbers,
 * JIDs, auth data, source message IDs, technical logs, or model
 * internals. `member_identifiers` is deliberately never joined here.
 *
 * First pass (2026-08-07): only the tabs that already have real data —
 * MEMBERS, DAILY_REPORTS, REPORT_ITEMS. TASKS/TASK_ASSIGNEES/
 * TASK_HISTORY/DASHBOARD/candidate-derived tabs are empty until the
 * candidate-promotion loop actually produces real tasks (see
 * scheduler.ts's morning-summary wiring) — building their export now
 * would just export zero rows. Deferred, not forgotten.
 */

function formatJakartaDateTime(instant: Date | null): string {
  if (!instant) return "";
  const w = toJakartaWallClock(instant);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

export async function buildMembersRows(db: AppDatabase): Promise<string[][]> {
  const rows = await db.select().from(members).orderBy(members.preferredName);
  return [
    ["member_id", "Nama", "Peran", "Status Keanggotaan", "Wajib Lapor", "Mulai", "Berakhir", "Diperbarui"],
    ...rows.map((m) => [
      m.memberId,
      m.preferredName,
      m.role,
      m.membershipStatus,
      m.reportRequired ? "Ya" : "Tidak",
      formatJakartaDateTime(m.startDate),
      formatJakartaDateTime(m.endDate),
      formatJakartaDateTime(m.updatedAt),
    ]),
  ];
}

export async function buildDailyReportsRows(db: AppDatabase): Promise<string[][]> {
  const reports = await db.select().from(dailyReports);
  const memberRows = await db.select().from(members);
  const memberNameById = new Map(memberRows.map((m) => [m.memberId, m.preferredName]));

  const revisions = await db.select().from(reportRevisions);
  const revisionsByReportId = new Map<string, typeof revisions>();
  for (const rev of revisions) {
    const list = revisionsByReportId.get(rev.reportId) ?? [];
    list.push(rev);
    revisionsByReportId.set(rev.reportId, list);
  }

  const revisionIds = revisions.map((r) => r.revisionId);
  const items = revisionIds.length > 0 ? await db.select().from(reportItems).where(inArray(reportItems.revisionId, revisionIds)) : [];
  const itemCountByRevisionId = new Map<string, number>();
  for (const item of items) {
    itemCountByRevisionId.set(item.revisionId, (itemCountByRevisionId.get(item.revisionId) ?? 0) + 1);
  }

  const sorted = [...reports].sort((a, b) => b.reportingDay.localeCompare(a.reportingDay));

  return [
    ["Tanggal Lapor", "Nama", "Ada Aktivitas", "Jumlah Item", "Revisi Terakhir", "Menunggu Konfirmasi Admin", "Dibuat"],
    ...sorted.map((r) => {
      const reportRevs = revisionsByReportId.get(r.reportId) ?? [];
      const lastRevision = reportRevs.reduce((max, rev) => Math.max(max, rev.revisionNumber), 0);
      const itemCount = reportRevs.reduce((sum, rev) => sum + (itemCountByRevisionId.get(rev.revisionId) ?? 0), 0);
      return [
        r.reportingDay,
        memberNameById.get(r.memberId) ?? "(tidak dikenal)",
        r.noActivity ? "Tidak" : "Ya",
        String(itemCount),
        String(lastRevision),
        r.pendingAdminConfirmation ? "Ya" : "Tidak",
        formatJakartaDateTime(r.createdAt),
      ];
    }),
  ];
}

export async function buildReportItemsRows(db: AppDatabase): Promise<string[][]> {
  const items = await db.select().from(reportItems);
  const revisions = await db.select().from(reportRevisions);
  const revisionById = new Map(revisions.map((r) => [r.revisionId, r]));
  const reports = await db.select().from(dailyReports);
  const reportById = new Map(reports.map((r) => [r.reportId, r]));
  const memberRows = await db.select().from(members);
  const memberNameById = new Map(memberRows.map((m) => [m.memberId, m.preferredName]));

  const taskIds = [...new Set(items.map((i) => i.taskId).filter((id): id is string => id !== null))];
  const taskRows = taskIds.length > 0 ? await db.select().from(tasks).where(inArray(tasks.taskId, taskIds)) : [];
  const taskTitleById = new Map(taskRows.map((t) => [t.taskId, t.title]));

  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return [
    ["Tanggal Lapor", "Nama", "Judul Task", "Aktivitas", "Hasil", "Ada Kendala", "Status Item", "Dibuat"],
    ...sorted.map((item) => {
      const revision = revisionById.get(item.revisionId);
      const report = revision ? reportById.get(revision.reportId) : undefined;
      return [
        report?.reportingDay ?? "",
        report ? (memberNameById.get(report.memberId) ?? "(tidak dikenal)") : "",
        item.taskId ? (taskTitleById.get(item.taskId) ?? "") : "",
        item.activity,
        item.result ?? "",
        item.obstacle ? "Ya" : "Tidak",
        item.status,
        formatJakartaDateTime(item.createdAt),
      ];
    }),
  ];
}

/** Export-only (type-based, not per-date — weekly cadence, not daily). Reads the persisted table, doesn't recompute. */
export async function buildWeeklySummariesRows(db: AppDatabase): Promise<string[][]> {
  const rows = await db.select().from(weeklySummaries).orderBy(desc(weeklySummaries.weekStart));

  return [
    ["Minggu Mulai", "Provisional", "Task Selesai", "Masih Overdue", "Kendala", "Kepatuhan Lapor (%)", "Project", "Dikirim Pada"],
    ...rows.map((r) => {
      const content = r.content as WeeklySummary;
      const compliance = content.reportCompliance ?? [];
      const totalRequired = compliance.reduce((sum, c) => sum + c.requiredDays, 0);
      const totalReported = compliance.reduce((sum, c) => sum + c.reportedDays, 0);
      const compliancePct = totalRequired > 0 ? Math.round((totalReported / totalRequired) * 100) : 0;
      return [
        content.weekStart,
        r.provisional ? "Ya" : "Tidak",
        String(content.completedThisWeek?.length ?? 0),
        String(content.stillOverdue?.length ?? 0),
        String(content.obstaclesRaisedCount ?? 0),
        String(compliancePct),
        (content.projectsTouched ?? []).join(", "),
        formatJakartaDateTime(r.sentAt),
      ];
    }),
  ];
}

interface StoredBullet {
  text: string;
  label?: string;
  evidenceItemIds?: string[];
}

/** ADR-0016: one row per week and work stream, newest week first; reads weekly_stream_recaps, recomputes nothing. */
export async function buildWeeklyRecapRows(db: AppDatabase): Promise<string[][]> {
  const rows = await db.select().from(weeklyStreamRecaps).orderBy(desc(weeklyStreamRecaps.weekStart), desc(weeklyStreamRecaps.itemCount));
  const streams = await db.select().from(workStreams);
  const nameById = new Map(streams.map((s) => [s.streamId, s.name]));

  return [
    ["Pekan", "ID aliran", "Nama aliran", "Butir", "Orang", "Ringkasan", "Tertahan", "Hambatan", "Δ vs pekan lalu", "Bukti (report_item id)"],
    ...rows.map((r) => {
      const bullets = r.bullets as StoredBullet[];
      const delta = r.prevItemCount === 0 ? "baru" : r.itemCount - r.prevItemCount > 0 ? `+${r.itemCount - r.prevItemCount}` : String(r.itemCount - r.prevItemCount);
      return [
        r.weekStart,
        r.streamId,
        nameById.get(r.streamId) ?? r.streamId,
        String(r.itemCount),
        r.members,
        bullets.map((b) => (b.label ? `${b.label}: ${stripInlineAliases(b.text)}` : stripInlineAliases(b.text))).join("\n"),
        String(r.blockedCount),
        r.obstacles,
        delta,
        [...new Set(bullets.flatMap((b) => b.evidenceItemIds ?? []))].join(", "),
      ];
    }),
  ];
}

/** The registry, so admins can see (and rename in the database) the work streams. Renaming through the sheet is not synced back. */
export async function buildWorkStreamsRows(db: AppDatabase): Promise<string[][]> {
  const rows = await db.select().from(workStreams).orderBy(asc(workStreams.streamId));
  return [
    ["ID aliran", "Nama", "Nama pendek", "Asal", "Diarsipkan"],
    ...rows.map((s) => [s.streamId, s.name, s.shortName, s.origin, s.archivedAt ? "Ya" : ""]),
  ];
}
