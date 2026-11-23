import type { PipelineOutcome } from "./pipeline.ts";
import { countsLine, joinBlocks, taskLabel, titleLine } from "../format/wa.ts";

/** Per list. Hidden items keep their numbers, and a bare "ya" still answers all of them. */
const MAX_NUMBERED_SHOWN = 10;

/** One line of the activity, cut with an ellipsis so a long one cannot own the question. */
function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/**
 * MASTER_SPEC.md §9.7: a valid report gets a concise acknowledgment.
 * Every other outcome (duplicate, replay, unrecognized sender, non-report
 * chatter) stays silent by design — only report-shaped messages get a
 * reply, per the header pre-filter's whole point of keeping noise out of
 * the group.
 *
 * Bug found live (2026-08-07): the ack text hardcoded the literal word
 * "Agas" from §9.7's example sentence into every acknowledgment,
 * regardless of who actually sent the report. MASTER_SPEC.md §5.2 is
 * explicit that "Agas" is a generic placeholder name used throughout the
 * document ("If 'Agas' is sent from Budi's registered number, it is
 * Budi's report") — not a fixed bot persona or literal template word. A
 * real team happening to have an actual member named Agas made this
 * immediately, visibly wrong: every report in the group looked like it
 * was being attributed to that one person. Fixed by interpolating the
 * resolved sender's actual preferredName.
 */
export function formatAcknowledgment(outcome: PipelineOutcome): string | null {
  switch (outcome.status) {
    case "report_processed": {
      const s = outcome.summary;
      // Naming it as overtime matters: a member who filed a lembur report
      // needs to see it landed as one, not as their regular day.
      const label = outcome.overtime ? "Laporan lembur" : "Laporan";
      const counts = countsLine([
        [s.activityCount, "aktivitas"],
        [s.taskUpdateCount, "update task"],
        [s.taskDoneCount, "task selesai"],
      ]);
      const head = `${titleLine("✅", `${label} ${outcome.memberName} tercatat`)}\n${counts}`;
      const plan = outcome.plan;
      if (!plan) return head;

      // Only what the reporter can act on is shown. Flags that go to the
      // admins' morning summary (wrong PIC, done-vs-plan, ...) are deliberately
      // absent: a reply in the group that says "you are not the PIC" is a
      // public correction nobody asked for.
      //
      // Every plan-related item carries a number — links and questions share
      // one numbering — because the reporter answers per number
      // ("@helper 2 ya 3 bukan"); see plan/report-match-reply.ts.
      const numberedLine = (n: number, activity: string, task: { title: string; sourceReference: string | null }) =>
        `${n}. "${clip(activity, 50)}" → ${taskLabel(task)}`;
      const shownLines = (lines: string[]) => {
        const shown = lines.slice(0, MAX_NUMBERED_SHOWN);
        if (lines.length > MAX_NUMBERED_SHOWN) shown.push(`+${lines.length - MAX_NUMBERED_SHOWN} lainnya`);
        return shown;
      };

      const first = plan.linked[0];
      const related =
        plan.linked.length > 0
          ? [
              titleLine("🔗", "Terkait task urgent"),
              ...shownLines(plan.linked.map((l) => numberedLine(l.n, l.activity, { title: l.title, sourceReference: l.sourceReference }))),
              // With nothing to ask, the links are still correctable: say how.
              ...(plan.questions.length === 0 && first ? [`Salah cocok? Balas *@helper ${first.n} bukan* atau *@helper ${first.n} = 1.04*`] : []),
            ].join("\n")
          : null;

      const [q1, q2] = plan.questions;
      const answerHint = q1
        ? q2
          ? `Balas *@helper ya* kalau semua benar, atau per nomor: *@helper ${q1.n} ya ${q2.n} bukan* · *@helper ${q2.n} = 2.08*`
          : `Balas *@helper ya* kalau benar, atau *@helper ${q1.n} bukan* · *@helper ${q1.n} = 2.08*`
        : null;
      const question =
        plan.questions.length > 0
          ? [
              titleLine("❓", "Cek dulu ya"),
              ...shownLines(plan.questions.map((q) => numberedLine(q.n, q.activity, q.task))),
              answerHint,
            ].join("\n")
          : null;
      return joinBlocks(head, related, question);
    }
    case "report_no_activity":
      // §9.6: a no-activity report goes to pending_admin_confirmation and
      // the member is still considered missing until approved — the ack
      // must not read as full acceptance.
      return `${titleLine("📝", `Laporan ${outcome.memberName} tercatat`)}\nTidak ada aktivitas — menunggu konfirmasi admin.`;
    case "report_extraction_failed":
      // Found live 2026-08-08: silent LLM extraction failures left the
      // sender with no signal their report was lost. The message can
      // never be automatically retried (dedup is keyed on its ID before
      // this point), so resending as a new message is the only path.
      return `${titleLine("⚠️", `Laporan ${outcome.memberName} belum bisa diproses`)}\nAda gangguan teknis. Mohon kirim ulang laporannya.`;
    case "unrecognized_sender":
      // Silent by default (a stranger's DM, or non-report chatter) — a reply
      // is offered only when the pipeline judged this a report attempt from
      // inside the group. No name and no number: the sender is unknown, and
      // the message is generic so it identifies nobody in the group.
      return outcome.promptRegister
        ? `${titleLine("❓", "Nomor belum terdaftar")}\nAda laporan dari nomor yang belum terdaftar sebagai anggota divisi. Kalau ini kamu, minta admin daftarkan dulu ya biar laporannya tercatat.`
        : null;
    case "query_answered":
      // MASTER_SPEC.md §16: the LLM only extracts intent/parameters —
      // this text was built entirely by ../queries/format.ts from real
      // query results, never generated by the LLM.
      return outcome.replyText;
    case "report_not_recorded":
      // The message opens like a report but the header did not read as one, so
      // nothing was recorded. Said out loud: otherwise the member assumes it landed.
      return `${titleLine("⚠️", "Laporan belum tercatat")}
Judulnya belum terbaca sebagai laporan. Awali dengan baris seperti:
Report <nama> <tanggal>
lalu kirim ulang ya.`;
    case "report_unchanged":
      return "✅ Laporan ini sudah tercatat sebelumnya, tidak ada perubahan.";
    default:
      return null;
  }
}
