# Division Report Assistant

> **Note:** This is a cleaned showcase copy created for job applications. The original repository contains colleagues' data and internal project names that I cannot share, so this copy has fresh history, synthetic names, and the same architecture, code and tests.

A WhatsApp assistant that an engineering division uses every working day. Members post their daily reports in the group chat as they always have; the assistant stores them, reminds whoever has not reported, answers questions such as "who hasn't reported yet?", posts a morning summary, and keeps a shared Google Sheet and Excel workbook up to date for the supervisors.

Built by one person with AI coding agents (Claude Code, Codex, Antigravity), and running in production since August 2026.

## The problem

About 20 engineers report their daily work in one WhatsApp group. Before this assistant:

- the reports were free text in mixed formats ("report", "Report Lembur", markdown bold, photo captions, typos in names), so nobody could total them;
- a supervisor had to scroll the chat each morning to see who had not reported and what was blocked;
- any request for "yesterday's reports as Excel" meant someone copying messages into a spreadsheet by hand.

The goal was to change nothing about how members work (they keep writing in the group) and still get structured data out of it.

## How it works

```
WhatsApp group ──► Baileys connector ──► pipeline ──► PostgreSQL
                                           │               │
                         LLM (via LiteLLM) │               ├──► morning summary, reminders, weekly recap (pg-boss jobs)
                    extracts items only,   │               ├──► Google Sheets (date tabs, two-way TASKS tab)
                    validated by Zod       │               └──► daily Excel workbook (ExcelJS)
                                           ▼
                             questions are answered from SQL, not by the LLM
```

1. **Message in.** `src/whatsapp/baileys-connector.ts` receives group messages (text, and photo/video captions) and drops anything from other groups or from the bot itself.
2. **Report.** `src/messages/pipeline.ts` recognises a report header deterministically (`src/reports/header.ts`), redacts personal data, and asks the LLM to split the text into activity / result / obstacle / status items. The answer must pass a Zod schema (`src/llm/schemas.ts`) or it is rejected and retried; it is never stored half-valid.
3. **Stored.** Reports, items, members, projects, tasks and every LLM call (tokens and cost) live in PostgreSQL through Drizzle ORM (`src/db/schema.ts`, migrations in `drizzle/`).
4. **Morning summary.** At a fixed time `src/brief/` builds the facts with SQL (who reported, who is on leave, overdue plan steps, blockers) and the LLM only phrases them. Every step it mentions must be one of the facts it was given; anything else is dropped before sending.
5. **Workbook.** `src/sheets/` keeps one Google Sheets tab per day plus a two-way `TASKS` tab, and `src/export/daily-workbook.ts` produces an `.xlsx` for any day on request ("kirim report kemarin").

Other jobs (`src/jobs/`): report reminders, deadline reminders, stale-task detection, a weekly compliance summary, a weekly recap grouped by work stream (`src/recap/`), and a read-only sync from the division's master-plan spreadsheet (`src/plan/`).

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (strict), Fastify (health and readiness endpoints) |
| Database | PostgreSQL, Drizzle ORM, pg-boss for scheduled jobs; PGlite (in-memory Postgres) for tests |
| Validation | Zod, for config, every LLM response and every Sheets import |
| WhatsApp | Baileys (WhatsApp Web protocol) |
| Spreadsheets | Google Sheets API (googleapis), ExcelJS |
| LLM | DeepSeek through a self-hosted LiteLLM gateway, with a monthly budget guard (`src/llm/budget.ts`) |
| Deploy | Docker Compose, non-root user, read-only root filesystem, image tagged per commit |

## Safety and privacy

- **Personal data is redacted before any LLM call.** Phone numbers, WhatsApp IDs, @-mentions and registered member and project names are replaced with tokens such as `[MEMBER:…]` and restored afterwards (`src/llm/redaction.ts`, tested in `src/llm/redaction.test.ts`).
- **Answers come from SQL, not from the LLM.** For a question in the chat, the LLM only classifies the intent ("missing reporters", "tasks due today", …). The answer itself is a database query (`src/queries/executors.ts`) formatted by code, so the assistant cannot invent who has or has not reported.
- **Permissions are deterministic.** Who may cancel, reassign or approve is decided by `src/permissions/engine.ts`, never by the model. A change requested in chat runs only after an explicit "ya" confirmation (`src/queries/confirmation.ts`).
- **Nothing is hard-deleted.** Members who leave are marked inactive or resigned, and their history stays attached.
- Design documents: [`docs/MASTER_SPEC.md`](docs/MASTER_SPEC.md), [`docs/SECURITY_AND_PRIVACY.md`](docs/SECURITY_AND_PRIVACY.md), [`docs/ARCHITECTURE_PROPOSAL.md`](docs/ARCHITECTURE_PROPOSAL.md).

## Cost

The LLM is used narrowly (item extraction, intent classification, phrasing), with byte-stable system prompts for cache hits and thinking mode explicitly disabled. At the last count: **183 LLM calls cost USD 0.029 in total**. Every call is logged with its token counts and cost in the `llm_invocations` table, and calls stop when the monthly budget is reached.

## Four silent data-loss incidents, and the tests that guard them

The code was written with AI agents, and each of these passed the tests that existed at the time. Each was found by comparing the output with the real chat, fixed at the root, and is now pinned by a regression test.

| # | What happened | Guard test |
|---|---|---|
| 1 | Reports sent as a **photo or video caption** were silently dropped: the connector read only plain text messages. | `src/whatsapp/baileys-connector.test.ts`: "a report sent as a photo caption is dispatched, not dropped" |
| 2 | **Mentions of the bot were never recognised**: WhatsApp inserts the bot's number (or LID) instead of the word "helper", so questions and leave requests could not reach the bot at all. | `src/whatsapp/baileys-connector.test.ts`: "a mention of the bot's LID also counts …" |
| 3 | **22 daily reports were stored as empty** over two weeks: a default value in the Zod schema let an empty LLM answer pass as "no activity". All 22 were reprocessed and restored. | `src/llm/schemas.test.ts`: "an empty items list while noActivity is false is REJECTED …" |
| 4 | **Marking a member as resigned erased their history from the spreadsheet**: date tabs were built from active members only. 28 reports were restored. | `src/sheets/date-tabs.test.ts`: "a departed member's report still appears on the day they filed it" |

A related fix: `thinking: disabled` used to be written to the audit log but never sent to the API, so the model silently ran in its slower reasoning mode (`src/llm/client.test.ts`: "thinking mode defaults to disabled and is sent explicitly, not omitted").

## Running the tests

No database, credentials or WhatsApp connection needed. PostgreSQL runs in memory through PGlite.

```bash
npm install
npm run typecheck
npm test          # 802 tests
```

To run the app itself, copy `.env.example` to `.env`, fill in your own values, then run `npm run db:migrate` and `npm run dev`. Pairing with WhatsApp uses `src/whatsapp/pair.ts`.

## What is different from the original

- Member names, WhatsApp IDs and the bot's number are synthetic; client and product names are replaced with generic ones (Project Alpha, Beta, Vega, …).
- One-off maintenance scripts that only contained the real roster or project list were removed. The remaining scripts in `src/scripts/` show the pattern (dry run by default, `--apply` to write).
- Deployment notes that described private infrastructure were generalised. The member guide [`PANDUAN.md`](PANDUAN.md) is in Indonesian, as in the original.
