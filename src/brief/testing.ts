import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/testing.ts";
import { members, planItemChanges, planItems, reportItemFlags, taskAssignees, tasks } from "../db/schema.ts";
import { createMember } from "../members/service.ts";
import { setAvailability } from "../members/availability.ts";
import { confirmProject, createProject } from "../projects/service.ts";
import { mustFinishBeforeFor, sourceReferenceFor, taskStatusForPlan } from "../plan/mapping.ts";
import { addReportItem, addRevision, getOrCreateDailyReport } from "../reports/service.ts";
import { createTask } from "../tasks/service.ts";

/**
 * A small, fully specified Aerolift plan for the brief's tests. "Now" is
 * Saturday 2026-10-03 08:00 Jakarta; the previous reporting day is Friday
 * 2026-10-02. The comments name what each step is there to prove.
 */
export const BRIEF_NOW = new Date("2026-10-03T01:00:00.000Z");

export interface BriefWorld {
  db: TestDb;
  memberIds: Record<"admin" | "bagas" | "gunawan" | "wisnu" | "udin", string>;
  taskIds: Record<string, string>;
}

interface PlanSeed {
  id: string;
  area: string;
  step: string;
  pic: keyof BriefWorld["memberIds"];
  status: string;
  progress: number | null;
  start: string | null;
  deadline: string | null;
  risk?: string | null;
  support?: string | null;
  missing?: boolean;
}

const PLAN: readonly PlanSeed[] = [
  { id: "1.01", area: "BMS", step: "Soldering PCB BMS 4S", pic: "bagas", status: "Berjalan", progress: 40, start: "2026-09-24", deadline: "2026-09-28" }, // 5 days late
  { id: "1.02", area: "BMS", step: "Uji charging pack", pic: "gunawan", status: "Belum Mulai", progress: 0, start: "2026-09-30", deadline: "2026-10-01" }, // 2 days late
  { id: "2.01", area: "Frame", step: "Desain frame", pic: "wisnu", status: "Selesai", progress: 100, start: "2026-09-20", deadline: "2026-09-25" }, // done, so never late
  { id: "3.07", area: "Tether", step: "Integrasi winch tether", pic: "bagas", status: "Berjalan", progress: 60, start: "2026-10-01", deadline: "2026-10-03", risk: "Motor winch belum datang dari pengadaan", support: "Pengadaan" }, // due today, risk, no report: quiet
  { id: "3.08", area: "Tether", step: "Kalibrasi sensor tegangan", pic: "gunawan", status: "Berjalan", progress: 20, start: "2026-10-02", deadline: "2026-10-04" }, // due tomorrow
  { id: "4.03", area: "Flight", step: "Flight test indoor", pic: "gunawan", status: "Berjalan", progress: 10, start: "2026-10-01", deadline: "2026-10-10" }, // open window, no report: quiet
  { id: "4.04", area: "Flight", step: "Dokumentasi uji", pic: "wisnu", status: "Belum Mulai", progress: 0, start: "2026-10-03", deadline: "2026-10-12" }, // starts today, not quiet
  { id: "5.02", area: "Tether", step: "Pasang kabel tether", pic: "wisnu", status: "Selesai", progress: 100, start: "2026-09-29", deadline: "2026-10-02" }, // changed to Selesai yesterday
  { id: "6.02", area: "Pengadaan", step: "Pengadaan konektor XT90", pic: "bagas", status: "Blocked", progress: 10, start: "2026-10-01", deadline: "2026-10-08", risk: "Konektor belum dikirim supplier", support: "Tim Mechanical" },
  { id: "7.01", area: "Lama", step: "Langkah yang dihapus dari sheet", pic: "wisnu", status: "Berjalan", progress: 30, start: "2026-09-20", deadline: "2026-09-27", missing: true }, // missing: counted nowhere
];

/** Expected figures for BRIEF_NOW, so tests assert against one place. */
export const EXPECTED = {
  itemCount: 9,
  // (40 + 0 + 100 + 60 + 20 + 10 + 0 + 100 + 10) / 9 = 38
  overallProgressPct: 38,
  overdueRefs: ["aerolift:1.01", "aerolift:1.02"],
  daysLate: [5, 2],
  dueTodayRefs: ["aerolift:3.07"],
  dueTomorrowRefs: ["aerolift:3.08"],
  startingTodayRefs: ["aerolift:4.04"],
  quietRefs: ["aerolift:3.07", "aerolift:4.03"],
};

export async function seedBriefWorld(): Promise<BriefWorld> {
  const db = await createTestDb();
  const make = async (name: string, role: "member" | "admin" = "member") => {
    const m = await createMember(db, { preferredName: name, role });
    await db.update(members).set({ membershipStatus: "active" }).where(eq(members.memberId, m.memberId));
    return m.memberId;
  };
  const memberIds = {
    admin: await make("Admin", "admin"),
    bagas: await make("Bagas"),
    gunawan: await make("Gunawan"),
    wisnu: await make("Wisnu"),
    udin: await make("Udin"),
  };

  const project = await createProject(db, { name: "Aerolift Drone Mobil", createdByMemberId: memberIds.admin });
  await confirmProject(db, project.projectId);

  const taskIds: Record<string, string> = {};
  for (const p of PLAN) {
    const title = `${p.area}: ${p.step}`;
    const status = taskStatusForPlan(p.status) ?? "active";
    const [task] = await db
      .insert(tasks)
      .values({
        title,
        normalizedTitle: title.toLowerCase(),
        projectId: project.projectId,
        createdByMemberId: memberIds.admin,
        sourceReference: sourceReferenceFor("aerolift", p.id),
        scheduledFor: p.start,
        deadlineLabel: p.deadline,
        mustFinishBefore: p.deadline ? mustFinishBeforeFor(p.deadline) : null,
        status,
      })
      .returning();
    await db.insert(taskAssignees).values({ taskId: task!.taskId, memberId: memberIds[p.pic] });
    await db.insert(planItems).values({
      planRef: `aerolift:${p.id}`,
      taskId: task!.taskId,
      area: p.area,
      step: p.step,
      picRaw: p.pic,
      startDate: p.start,
      deadlineDate: p.deadline,
      statusText: p.status,
      progressPct: p.progress,
      risk: p.risk ?? null,
      support: p.support ?? null,
      lastSeenAt: BRIEF_NOW,
      missingSince: p.missing ? new Date("2026-10-01T01:00:00.000Z") : null,
    });
    taskIds[p.id] = task!.taskId;
  }

  // Reports for Friday 2026-10-02 (the reporting day that closed at 09:59 today)
  // and an older one for Wednesday 09-30, so "last 2 reporting days" reaches back.
  const bagasReport = await getOrCreateDailyReport(db, memberIds.bagas, "2026-10-02");
  const bagasRev = await addRevision(db, bagasReport.reportId, "report");
  const solder = await addReportItem(db, bagasRev.revisionId, { activity: "soldering PCB BMS", taskId: taskIds["1.01"]!, status: "worked_on" });
  await addReportItem(db, bagasRev.revisionId, {
    activity: "cek pengiriman konektor XT90",
    taskId: taskIds["6.02"]!,
    obstacle: "Konektor belum datang, supplier belum konfirmasi, hubungi 081234567890",
    obstacleCategory: "waiting_component",
    status: "blocked",
  });
  const wisnuReport = await getOrCreateDailyReport(db, memberIds.wisnu, "2026-10-02");
  const wisnuRev = await addRevision(db, wisnuReport.reportId, "report");
  await addReportItem(db, wisnuRev.revisionId, {
    activity: "rakit panel lama",
    obstacle: "Kunci panel hilang",
    obstacleCategory: "resource_unavailable",
    status: "in_progress",
  });
  const oldReport = await getOrCreateDailyReport(db, memberIds.gunawan, "2026-09-30");
  const oldRev = await addRevision(db, oldReport.reportId, "report");
  await addReportItem(db, oldRev.revisionId, { activity: "kalibrasi sensor", taskId: taskIds["3.08"]!, status: "worked_on" });
  // A corrected-away revision: the obstacle above belongs to revision 1 and must NOT show up.
  const correctedRev = await addRevision(db, wisnuReport.reportId, "report koreksi");
  await addReportItem(db, correctedRev.revisionId, { activity: "pasang kabel tether", taskId: taskIds["5.02"]!, status: "done" });

  // Plan changes: three inside the window (yesterday, Jakarta), one before it.
  await db.insert(planItemChanges).values([
    { planRef: "aerolift:5.02", taskId: taskIds["5.02"]!, field: "progress", oldValue: "50%", newValue: "100%", detectedAt: new Date("2026-10-02T03:00:00.000Z") },
    { planRef: "aerolift:5.02", taskId: taskIds["5.02"]!, field: "status", oldValue: "Berjalan", newValue: "Selesai", detectedAt: new Date("2026-10-02T03:00:00.000Z") },
    { planRef: "aerolift:3.08", taskId: taskIds["3.08"]!, field: "deadline", oldValue: "2026-10-03", newValue: "2026-10-04", detectedAt: new Date("2026-10-02T09:00:00.000Z") },
    { planRef: "aerolift:1.02", taskId: taskIds["1.02"]!, field: "status", oldValue: "Berjalan", newValue: "Belum Mulai", detectedAt: new Date("2026-09-30T01:00:00.000Z") },
  ]);

  // Flags: two open inside the window, one resolved, one open but older than the window.
  const flag = (kind: string, state: string, createdAt: string, taskId: string | null, detail: object) => ({
    itemId: solder.itemId,
    reportId: bagasReport.reportId,
    memberId: memberIds.bagas,
    taskId,
    kind,
    detail,
    state,
    createdAt: new Date(createdAt),
  });
  await db.insert(reportItemFlags).values([
    flag("done_vs_plan", "open", "2026-10-02T14:00:00.000Z", taskIds["1.01"]!, { planRef: "aerolift:1.01", note: "belum ada bukti uji" }),
    flag("low_confidence", "open", "2026-10-02T15:00:00.000Z", null, { planRef: "3.07" }),
    flag("other_pic", "resolved", "2026-10-02T14:00:00.000Z", null, {}),
    flag("early_start", "open", "2026-09-28T14:00:00.000Z", null, {}),
  ]);

  // Non-plan work and people.
  const plain = await createTask(db, { title: "Rapikan gudang", createdByMemberId: memberIds.admin });
  await setAvailability(db, memberIds.udin, "izin", { year: 2026, month: 10, day: 3 });

  return { db, memberIds, taskIds };
}
