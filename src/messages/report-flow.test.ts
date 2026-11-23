import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { incomingMessages, reportRevisions } from "../db/schema.ts";
import { createMember, relinkWhatsappJid, resolveMemberByJid, setMemberLevel, setMembershipStatus } from "../members/service.ts";
import { getDailyReport } from "../reports/service.ts";
import { formatAcknowledgment } from "./acknowledgment.ts";
import { processIncomingMessage, processReportContent, type PipelineDeps } from "./pipeline.ts";
import { reportKindFor } from "../reports/kind.ts";
import type { IncomingMessage } from "../whatsapp/connector.ts";

const NOW = new Date("2026-10-03T03:00:00.000Z"); // Saturday 10:00 WIB, reporting day 2026-10-03
const JID = "628111@s.whatsapp.net";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

async function setup() {
  const db = await createTestDb();
  const member = await createMember(db, { preferredName: "Setiawan" });
  await setMembershipStatus(db, member.memberId, "active");
  await relinkWhatsappJid(db, member.memberId, JID);
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ noActivity: false, items: [{ activity: "troubleshooting PCB SMD", status: "in_progress" }] }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 150 },
    });
  }) as typeof fetch;
  const deps: PipelineDeps = { db, llm: { baseUrl: "http://litellm.test", fetchImpl }, now: NOW };
  let counter = 0;
  const send = (text: string, overrides: Partial<IncomingMessage> = {}) => {
    counter++;
    return processIncomingMessage(deps, {
      messageId: `wa-flow-${counter}`,
      chatJid: "group-1@g.us",
      isGroup: true,
      senderJid: JID,
      text,
      messageTimestamp: NOW,
      receivedAt: NOW,
      ...overrides,
    });
  };
  return { db, member, bodies, send };
}

const LRM = "‎";
const withLrm = (text: string) =>
  text
    .split("\n")
    .map((line) => `${LRM}${line}`)
    .join("\n");

// 2026-10-03: a member re-sent his corrected report three times; each line began with U+200E
// and all three revisions were silently dropped.
test("a report with U+200E at the start of every line (blank lines too) is processed as a revision of the same overtime report", async () => {
  const { db, member, bodies, send } = await setup();
  const original = "Report Lembur Setiawan\ntanggal 3 Oktober 2026\n\n- troubleshooting PCB SMD";
  assert.equal((await send(original)).status, "report_processed");

  for (const body of ["- troubleshooting PCB SMD\n- solder ulang konektor", "- troubleshooting PCB SMD\n- solder ulang konektor\n- tes arus", "- tes arus selesai"]) {
    const copied = withLrm(`Report Lembur Setiawan\ntanggal 3 Oktober 2026\n\n${body}`);
    assert.equal(copied.split("\n")[2], LRM, "the blank line carries the mark too");
    const outcome = await send(copied);
    assert.equal(outcome.status, "report_processed");
    if (outcome.status === "report_processed") assert.equal(outcome.overtime, true);
  }

  const report = await getDailyReport(db, member.memberId, "2026-10-03", "overtime");
  assert.ok(report);
  const revisions = await db.select().from(reportRevisions).where(eq(reportRevisions.reportId, report.reportId));
  assert.equal(revisions.length, 4, "the three re-sends are revisions 2-4 of the one report");
  assert.ok(revisions.every((r) => !r.rawText.includes(LRM)), "the stored revision text is normalized");
  assert.ok(bodies.every((b) => !b.includes("\\u200e") && !b.includes(LRM)), "the LLM never sees the invisible marks");

  const raw = await db.select().from(incomingMessages);
  assert.ok(raw.some((m) => m.rawText?.includes(LRM)), "incoming_messages.raw_text keeps the original for audit");
  assert.equal(await getDailyReport(db, member.memberId, "2026-10-03", "regular"), null);
});

test("a no-break space in the header line does not hide a report either", async () => {
  const { send } = await setup();
  assert.equal((await send("Report Agas\n- kerja")).status, "report_processed");
});

const LONG_PARAGRAPH =
  "report hari ini saya melakukan troubleshooting dan menemukan bahwa penggunaan pcb smd pada rangkaian charger menyebabkan arus bocor, " +
  "lalu saya ganti komponen dan test ulang beberapa kali sampai hasilnya stabil, besok lanjut merapikan kabel dan pengujian akhir";

test("a report-looking message without a readable header gets a reply instead of silence (group and DM)", async () => {
  const { bodies, send } = await setup();

  for (const isGroup of [true, false]) {
    const outcome = await send(LONG_PARAGRAPH, { isGroup });
    assert.equal(outcome.status, "report_not_recorded");
    assert.equal(
      formatAcknowledgment(outcome),
      "⚠️ *Laporan belum tercatat*\nJudulnya belum terbaca sebagai laporan. Awali dengan baris seperti:\nReport <nama> <tanggal>\nlalu kirim ulang ya.",
    );
  }
  assert.equal(bodies.length, 0, "no LLM call is spent on it");
});

test("casual chat that merely mentions a report stays silent", async () => {
  const { send } = await setup();
  for (const text of ["udah report belum?", "lapor dong", "oke siap bang"]) {
    const outcome = await send(text);
    assert.equal(outcome.status, "stored_as_context", text);
    assert.equal(formatAcknowledgment(outcome), null);
  }
});

test("an unregistered sender gets the registration hint, not the 'not recorded' one", async () => {
  const { send } = await setup();
  const outcome = await send(LONG_PARAGRAPH, { senderJid: "62999@s.whatsapp.net" });
  assert.equal(outcome.status, "unrecognized_sender");
});

test("an exact re-send of the latest revision is acknowledged as unchanged, with no LLM call and no new revision", async () => {
  const { db, member, bodies, send } = await setup();
  const text = "Report Setiawan\ntanggal 3 Oktober 2026\n- troubleshooting PCB SMD";
  assert.equal((await send(text)).status, "report_processed");
  assert.equal(bodies.length, 1);

  for (const again of [text, withLrm(text), `${text}  \n`]) {
    const outcome = await send(again);
    assert.equal(outcome.status, "report_unchanged");
    assert.equal(formatAcknowledgment(outcome), "✅ Laporan ini sudah tercatat sebelumnya, tidak ada perubahan.");
  }
  assert.equal(bodies.length, 1);
  const report = await getDailyReport(db, member.memberId, "2026-10-03");
  assert.equal((await db.select().from(reportRevisions).where(eq(reportRevisions.reportId, report!.reportId))).length, 1);

  assert.equal((await send(`${text}\n- tes arus`)).status, "report_processed", "any real change is still a revision");
});

test("a redelivery of the same message is still silent, and replayed/context outcomes stay silent", () => {
  assert.equal(formatAcknowledgment({ status: "duplicate" }), null);
  assert.equal(formatAcknowledgment({ status: "replayed" }), null);
  assert.equal(formatAcknowledgment({ status: "stored_as_context" }), null);
});

// Found 2026-10-04 in a cloned-DB rehearsal: reprocessing Setiawan's "Report Lembur Setiawan"
// created a NEW regular report, because the report kind was only computed in the live path.
test("reprocessing (processReportContent, as the admin scripts call it) lands in the same report kind as the live path", async () => {
  const { db, member: created, send } = await setup();
  await setMemberLevel(db, created.memberId, "staff");
  const member = (await resolveMemberByJid(db, JID))!;
  const llm = {
    baseUrl: "http://litellm.test",
    fetchImpl: (async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ noActivity: false, items: [{ activity: "troubleshooting PCB SMD", status: "in_progress" }] }) } }],
        usage: { prompt_tokens: 500, completion_tokens: 150 },
      })) as typeof fetch,
  };
  const revisionCount = async (kind: "overtime" | "regular") => {
    const report = await getDailyReport(db, member.memberId, "2026-10-03", kind);
    if (!report) return 0;
    return (await db.select().from(reportRevisions).where(eq(reportRevisions.reportId, report.reportId))).length;
  };

  // 1. An overtime header.
  await send("Report Lembur Setiawan\ntanggal 3 Oktober 2026\n- troubleshooting PCB SMD");
  assert.equal(await revisionCount("overtime"), 1);
  await processReportContent(db, llm, member, "Report Lembur Setiawan\ntanggal 3 Oktober 2026\n- koreksi", "reprocess-1", NOW);
  assert.equal(await revisionCount("overtime"), 2);
  assert.equal(await revisionCount("regular"), 0);

  // 2. A Saturday staff message with no "lembur" anywhere: overtime by the Saturday rule.
  assert.equal(reportKindFor("Report Setiawan\n- kerja", { year: 2026, month: 10, day: 3 }, member), "overtime");
  await send("Report Setiawan\ntanggal 3 Oktober 2026\n- kerja saturday");
  assert.equal(await revisionCount("overtime"), 3);
  await processReportContent(db, llm, member, "Report Setiawan\n- kerja saturday lagi", "reprocess-2", NOW);
  assert.equal(await revisionCount("overtime"), 4);
  assert.equal(await revisionCount("regular"), 0);

  // An intern (magang) on a Saturday without the header stays regular.
  assert.equal(reportKindFor("Report Budi\n- kerja", { year: 2026, month: 10, day: 3 }, { level: "magang" }), "regular");
});
