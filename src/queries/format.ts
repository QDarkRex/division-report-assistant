import type { QueryResult } from "./executors.ts";
import { clockLabel } from "./overtime-intent.ts";
import type { Task } from "../tasks/types.ts";
import { lastFinishDay } from "../tasks/deadline.ts";
import {
  bulletList,
  clampMessage,
  countsLine,
  dayLabel,
  joinBlocks,
  relativeDeadline,
  reportItemStatusLabel,
  section,
  statusLabel,
  taskLabel,
  titleLine,
} from "../format/wa.ts";

/**
 * Pure rendering to Indonesian text — deliberately NO LLM import in this
 * file. MASTER_SPEC.md §16: "Do not answer operational questions from
 * LLM memory." The LLM's job ends at intent+parameter extraction
 * (executors.ts consumes that); every word a member reads here comes
 * from a real database query, formatted by plain code.
 *
 * Layout follows ../format/wa.ts: emoji + bold title, blank line between
 * sections, "• " bullets. `now` is only needed to say how far off a
 * deadline is; it defaults to the clock so callers that do not care (the
 * tests that check wording) need not pass it.
 */
export function formatQueryResult(result: QueryResult, now: Date = new Date()): string {
  return clampMessage(render(result, now));
}

// A status order that puts what needs attention first and what is finished
// last. A status missing from here (a future enum value) still renders,
// after the known ones.
const STATUS_ORDER = ["blocked", "status_conflict", "in_progress", "active_unreviewed", "active", "paused", "stale", "done", "cancelled"];
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

function isOpen(task: Task): boolean {
  return !CLOSED_STATUSES.has(task.status);
}

function isOverdue(task: Task, now: Date): boolean {
  return isOpen(task) && task.mustFinishBefore !== null && now.getTime() >= task.mustFinishBefore.getTime();
}

/**
 * One task as a list item. ⚠️ marks a blocked or overdue open task, ✅ a
 * finished one — nothing else gets a marker, so the marks stay meaningful.
 * `deadline` picks how the deadline reads: "relative" (hari ini / H-3 /
 * terlambat 2 hari) or "date" (the last day it can be finished, with
 * overdue still said relatively because "how late" is the point there).
 */
function taskItem(task: Task, now: Date, deadline: "relative" | "date" | "none" = "relative"): string {
  const marker = task.status === "done" ? "✅ " : task.status === "blocked" || isOverdue(task, now) ? "⚠️ " : "";
  let suffix = "";
  if (deadline !== "none" && isOpen(task) && task.mustFinishBefore) {
    suffix =
      deadline === "date" && !isOverdue(task, now)
        ? ` — ${dayLabel(lastFinishDay(task.mustFinishBefore))}`
        : ` — ${relativeDeadline(task.mustFinishBefore, now)}`;
  }
  return `${marker}${taskLabel(task)}${suffix}`;
}

function groupByStatus(tasks: readonly Task[]): Array<[string, Task[]]> {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) groups.set(task.status, [...(groups.get(task.status) ?? []), task]);
  const rank = (status: string) => {
    const i = STATUS_ORDER.indexOf(status);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/** "Ada beberapa X mirip ..." with the candidates as bullets, or the plain not-found line when there are none. */
function disambiguation(noun: string, searchText: string, candidates: readonly string[]): string {
  if (candidates.length === 0) return titleLine("🔍", `${noun.charAt(0).toUpperCase()}${noun.slice(1)} tidak ditemukan`, `"${searchText}"`);
  return joinBlocks(titleLine("🔍", `Ada beberapa ${noun} mirip "${searchText}"`), bulletList(candidates).join("\n"), "Maksudnya yang mana?");
}

function denied(reason: string): string {
  return `${titleLine("🚫", "Ditolak")}\n${reason}`;
}

function dayList(days: readonly string[]): string {
  return bulletList(days.map(dayLabel), { max: 15 }).join("\n");
}

function render(result: QueryResult, now: Date): string {
  switch (result.kind) {
    case "tasks_today":
      return result.dueToday.length === 0
        ? titleLine("📅", "Jatuh tempo hari ini", "tidak ada task")
        : joinBlocks(
            titleLine("📅", "Jatuh tempo hari ini", `${result.dueToday.length} task`),
            bulletList(result.dueToday.map((t) => taskItem(t, now, "none"))).join("\n"),
          );

    case "nearest_deadline": {
      const buckets: Array<[string, Task[]]> = [
        ["Terlambat", result.overdue],
        ["Hari ini", result.dueToday],
        ["Besok (H-1)", result.h1],
        ["H-3", result.h3],
      ];
      const shown = buckets.filter(([, tasks]) => tasks.length > 0);
      if (shown.length === 0) return titleLine("⏰", "Deadline terdekat", "tidak ada dalam waktu dekat");
      const total = shown.reduce((sum, [, tasks]) => sum + tasks.length, 0);
      return joinBlocks(
        titleLine("⏰", "Deadline terdekat", `${total} task`),
        ...shown.map(([label, tasks]) => section(`${label} (${tasks.length})`, bulletList(tasks.map((t) => taskItem(t, now, "date")), { max: 6 }))),
      );
    }

    case "member_tasks": {
      // "tidak ada task hari itu" and "tidak pegang task sama sekali" are
      // different answers, and giving the second when the first was asked
      // reads as though the person has nothing on at all.
      const name = result.member.preferredName;
      const scope = result.scheduledFor ? `untuk ${dayLabel(result.scheduledFor)}` : null;
      if (result.tasks.length === 0) return titleLine("📋", `Task ${name}`, `tidak ada task ${scope ?? "yang sedang dikerjakan"}`);
      const openCount = result.tasks.filter(isOpen).length;
      return joinBlocks(
        titleLine("📋", `Task ${name}`, [scope, `${openCount} terbuka`].filter(Boolean).join(" · ")),
        ...groupByStatus(result.tasks).map(([status, tasks]) =>
          section(`${statusLabel(status)} (${tasks.length})`, bulletList(tasks.map((t) => taskItem(t, now)), { max: 6 })),
        ),
      );
    }

    case "member_not_found":
      return disambiguation("member", result.searchText, result.candidates.map((m) => m.preferredName));

    case "missing_reporters":
      return result.members.length === 0
        ? titleLine("✅", "Semua sudah lapor hari ini")
        : joinBlocks(
            titleLine("⏰", "Belum lapor hari ini", `${result.members.length} orang`),
            bulletList(result.members.map((m) => m.preferredName), { max: 20 }).join("\n"),
          );

    case "task_status": {
      const { task } = result;
      const status = [statusLabel(task.status), isOpen(task) && task.mustFinishBefore ? relativeDeadline(task.mustFinishBefore, now) : null]
        .filter(Boolean)
        .join(" · ");
      return [titleLine("📌", taskLabel(task)), `Status: ${status}`, task.latestUpdate ? `Update terakhir: ${task.latestUpdate}` : ""].filter(Boolean).join("\n");
    }

    case "task_not_found":
      return disambiguation("task", result.searchText, result.candidates.map((t) => taskLabel(t)));

    case "member_report": {
      const heading = titleLine("📝", `Laporan ${result.member.preferredName}`, dayLabel(result.reportingDay));
      if (result.noReport) return `${heading}\nBelum lapor.`;
      if (result.noActivity) return `${heading}\nMelaporkan tidak ada aktivitas.`;
      if (result.items.length === 0) return `${heading}\nTidak ada aktivitas tercatat.`;
      const items = result.items.map((i) => {
        const marker = i.status === "done" ? "✅ " : i.status === "blocked" ? "⚠️ " : "";
        return `${marker}${i.activity}${i.result ? ` — ${i.result}` : ""} (${reportItemStatusLabel(i.status)})`;
      });
      return joinBlocks(heading, bulletList(items, { max: 15 }).join("\n"));
    }

    case "stale_tasks":
      return result.tasks.length === 0
        ? titleLine("⏳", "Task macet", "tidak ada")
        : joinBlocks(titleLine("⏳", "Task macet", `${result.tasks.length} task`), bulletList(result.tasks.map((t) => taskItem(t, now, "none"))).join("\n"));

    case "project_summary": {
      const title = `Project ${result.project.name}`;
      if (result.tasks.length === 0) return titleLine("📁", title, "belum ada task tercatat");
      const counts = groupByStatus(result.tasks).map(([status, tasks]) => [tasks.length, statusLabel(status).toLowerCase()] as const);
      return joinBlocks(
        titleLine("📁", title, `${result.tasks.length} task`),
        countsLine(counts),
        bulletList(
          result.tasks.map((t) => `${taskItem(t, now, "none")} — ${statusLabel(t.status)}`),
          { max: 10 },
        ).join("\n"),
      );
    }

    case "project_not_found":
      return disambiguation("project", result.searchText, result.candidates.map((p) => p.name));

    case "overtime_today": {
      const heading = `Lembur ${dayLabel(result.day)}`;
      if (result.reporters.length === 0) return `${titleLine("🕐", heading)}\nBelum ada yang lembur.`;
      const names = result.reporters.map((r) => {
        const range = r.startText && r.endText ? ` (${r.startText}–${r.endText})` : r.startText ? ` (mulai ${r.startText})` : "";
        return `${r.preferredName}${range}`;
      });
      return joinBlocks(titleLine("🕐", heading, `${names.length} orang`), bulletList(names, { max: 20 }).join("\n"));
    }

    case "overtime_checked_in": {
      // Names the day so a mis-parsed "hari ini" is visible, echoes the
      // start time so a mis-heard one is caught, and points to the next
      // step so the check-in is not mistaken for the report.
      const heading = titleLine("🕐", `Lembur ${dayLabel(result.day)} tercatat`, result.startText ? `mulai ${result.startText}` : undefined);
      return result.alreadyReported
        ? `${heading}\nLaporan lemburnya juga sudah masuk.`
        : `${heading}\nNanti kirim laporan lemburnya, awali dengan "Report lembur".`;
    }

    case "overtime_checked_out":
      return titleLine("🕐", `Lembur ${dayLabel(result.day)} selesai`, result.endText ? `${clockLabel(result.endText)}, tercatat` : "ditandai selesai");

    case "overtime_checkin_denied":
      return denied("Hanya anggota aktif yang bisa absen lembur.");

    case "task_created": {
      const who = result.assignees.length > 0 ? result.assignees.map((a) => a.preferredName).join(" dan ") : "belum ada";
      // Echoed back in full on purpose: this is the one place a model's
      // reading of a sentence turns into a row other people get chased
      // about, and this line is the admin's only chance to catch it.
      return joinBlocks(
        titleLine("✅", "Task dibuat"),
        [`"${result.task.title}"`, result.scheduledFor ? `Hari kerja: ${dayLabel(result.scheduledFor)}` : "", `Penanggung jawab: ${who}`]
          .filter(Boolean)
          .join("\n"),
      );
    }

    case "task_create_denied":
      return denied("Hanya admin yang bisa membuat dan menugaskan task lewat chat.");

    case "task_create_needs_title":
      return `${titleLine("❓", "Task-nya mau diberi judul apa?")}\nSebutkan pekerjaannya, misal: tugaskan Nisa besok centering docking.`;

    case "task_create_unresolved_names":
      return joinBlocks(
        titleLine("❓", "Tidak yakin siapa yang dimaksud"),
        bulletList(result.names).join("\n"),
        "Tidak ada task yang dibuat — sebutkan nama yang terdaftar.",
      );

    case "daily_report_export":
      // The row count is stated on purpose: the admin forwards this file
      // onward without opening it, and "12 baris" is the only chance they
      // get to notice it is not the day they meant.
      return `${titleLine("📤", `Laporan ${dayLabel(result.day)} siap`, `${result.rowCount} baris`)}\nFile terlampir, tinggal diteruskan.`;

    case "daily_report_export_denied":
      return denied("Hanya admin yang bisa mengirim laporan keluar divisi.");

    case "daily_report_export_empty":
      return `${titleLine("📤", `Laporan ${dayLabel(result.day)}`, "belum ada laporan")}\nTidak ada yang dikirim.`;

    case "availability_set":
      // Every day is listed back, not just a count. A member who named four
      // days needs to see four days to know none were dropped — which is
      // exactly what used to happen silently. The reason is echoed for the
      // same reason: if the model misheard it, they see it now rather than
      // finding it wrong in the spreadsheet a week later.
      return joinBlocks(
        titleLine("📆", "Tercatat", `${result.member.preferredName} ${result.availabilityKind}`),
        dayList(result.days),
        result.reason ? `Alasan: ${result.reason}` : "",
      );

    case "availability_cancelled":
      return joinBlocks(
        titleLine("↩️", "Dibatalkan", result.member.preferredName),
        `Catatan izin/cuti/sakit pada tanggal berikut sudah dihapus:\n${dayList(result.days)}`,
      );

    case "availability_nothing_to_cancel":
      return joinBlocks(
        titleLine("ℹ️", "Tidak ada yang dibatalkan", result.member.preferredName),
        `Tidak ada catatan izin/cuti/sakit pada tanggal berikut yang bisa dibatalkan:\n${dayList(result.days)}`,
      );

    case "availability_missing_kind":
      return `${titleLine("❓", "Jenis izin tidak jelas")}\nSebutkan izin, cuti, atau sakit.`;

    case "availability_denied":
      return denied("Tidak bisa mencatat izin untuk anggota lain kecuali admin.");

    case "unknown":
      return `${titleLine("❓", "Maaf, saya tidak mengerti pertanyaannya")}\nCoba tanyakan dengan cara lain.`;
  }
}
