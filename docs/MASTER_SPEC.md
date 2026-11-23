# WhatsApp Division Helper — Master Specification

> **Document type:** Reviewed specification  
> **Status:** Phase 0 — documentation only, no production behavior  
> **Source:** Agent brief 2026-08-06, reviewed against personal infrastructure repository  
> **See also:** [REPOSITORY_REVIEW.md](REPOSITORY_REVIEW.md), [ARCHITECTURE_PROPOSAL.md](ARCHITECTURE_PROPOSAL.md), [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)

---

## 1. Project Goal

Build a 24/7 WhatsApp group helper for the **Electrical Division**.

The helper will:

- read messages from an existing WhatsApp group;
- filter irrelevant conversation;
- identify members by WhatsApp number/JID;
- record tasks, assignments, deadlines, status changes, results, and obstacles;
- parse daily reports;
- link report items to existing tasks;
- create candidate tasks when a report introduces new work;
- answer natural-language questions about division work;
- send scheduled reminders and summaries;
- maintain permanent history and audit logs;
- synchronize a sanitized view to Google Sheets;
- run continuously on the home server.

Group size: approximately 23 members, 3 administrators.

Work schedule: Monday through Saturday. Saturday is primarily a wrap-up day.

---

## 2. Technical Direction

This project must be implemented as a **purpose-built, deterministic service**, not a general autonomous agent.

```text
WhatsApp connector
        ↓
Message ingestion and deduplication
        ↓
Deterministic routing and permission checks
        ↓
LLM classification/extraction when needed
        ↓
Schema validation
        ↓
Task/report/member services
        ↓
PostgreSQL transaction and audit event
        ↓
Scheduler and job queue
        ↓
WhatsApp response / Google Sheets synchronization
```

**The LLM is not the source of truth.** It must not directly mutate state.

---

## 3. Stack Decisions

### 3.1 WhatsApp Connector — Baileys

- TypeScript WebSocket-based WhatsApp Web integration;
- no Chromium or Selenium requirement;
- supports multi-device, group messages, replies, mentions;
- unofficial integration — may break on protocol changes;
- session handling must be persistent and protected;
- connector code must be isolated behind an adapter interface.

```ts
interface WhatsAppConnector {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(input: SendTextInput): Promise<SentMessage>;
  sendMention(input: SendMentionInput): Promise<SentMessage>;
  getConnectionStatus(): ConnectionStatus;
  onMessage(handler: IncomingMessageHandler): void;
  onMessageUpdate(handler: MessageUpdateHandler): void;
  onConnectionUpdate(handler: ConnectionUpdateHandler): void;
}
```

`sendMention` stays in the adapter interface but is unused by v1 — see §11.1's ban-risk decision.
It exists so a later phase can add opt-in per-member tagging without an interface change.

### 3.2 Backend — TypeScript + Fastify

- same ecosystem as Baileys;
- strong typing with Zod schema validation;
- modular monolith for version one;
- dedicated Docker container on the server.

**Repository fit note:** No existing Node.js/TypeScript services in this repo. This introduces a new runtime, containerized via Docker Compose.

### 3.3 Database — PostgreSQL

- reuse the existing PostgreSQL instance on the server;
- create a separate database `whatsapp_division`, not shared with any other service on the instance;
- use Drizzle ORM (no existing ORM in repo to conflict with).

### 3.4 Job Queue — pg-boss

- keeps initial deployment dependent only on PostgreSQL;
- no Redis needed;
- handles morning summaries, deadline reminders, report reminders, stale detection, weekly wrap-up, Sheets sync, LLM retry, cleanup.

### 3.5 Validation — Zod

- every LLM result must pass strict runtime validation before use.

### 3.6 LLM — DeepSeek V4 Flash

- non-thinking mode by default for: message classification, report extraction, query intent parsing, simple summaries;
- thinking mode only when justified: ambiguous instructions, complex conflicts, weekly synthesis;
- **never** delegate identity, admin authorization, permission checks, deadline calculation, scheduler behavior, or database transactions to the LLM.

**Repository fit note:** LiteLLM currently has no DeepSeek model configured. Must add `deepseek-v4-flash` alias to LiteLLM config or call DeepSeek API directly.

### 3.7 Google Sheets

- service account with yearly workbook;
- one-way export first, limited two-way edits after validation;
- database remains authoritative.

### 3.8 Deployment — Docker Compose

- follow existing `deployments/<service>/compose.yaml` convention;
- containers: `division-report-assistant`, optionally `postgres-backup`;
- secrets at `/opt/app/secrets/division-report-assistant/`.

---

## 4. LLM Budget

### 4.1 Initial Budget

```text
Rp100,000 total prepaid budget (~US$5-6)
```

### 4.2 Monthly Targets

```text
Target monthly cost:     Rp8,000–15,000
Soft monthly limit:      Rp15,000
Hard monthly limit:      Rp25,000
Daily warning threshold: Rp1,000
```

### 4.3 Expected Lifespan

```text
Normal operation:        6–12 months
Early pilot:             3–6 months
Optimized steady state:  potentially >12 months
```

### 4.4 Degradation Behavior

**Soft limit reached:**
- disable automatic thinking mode;
- use non-thinking mode only;
- reduce task candidates sent to model;
- shorten context windows;
- notify administrators.

**Hard limit reached:**
- allow LLM only for: daily reports, explicit admin instructions, required clarifications, scheduled summaries that cannot be produced deterministically;
- process simple queries deterministically;
- never silently stop report ingestion;
- notify all administrators;
- record budget state in audit log.

### 4.5 Required Controls

1. Deterministic filtering before LLM calls;
2. never send stickers, reactions, greetings, or noise to the model;
3. one model call per report when practical;
4. extract activity, result, obstacle, status, and task candidates in one structured response;
5. retrieve only 3–5 most relevant task candidates;
6. never send complete task database or full group history;
7. bound retries;
8. conservative maximum output tokens;
9. reuse stable system instructions for cache eligibility;
10. record cost per feature.

---

## 5. WhatsApp Behavior

### 5.1 Dedicated Account

- dedicated WhatsApp number added to existing division group;
- persist encrypted auth/session state;
- documented pairing-code or QR recovery;
- no auth state in Git.

### 5.2 Identity

Authoritative member identity: **WhatsApp JID / phone-number mapping**.

Typed name in a report is only a label. If "Agas" is sent from Budi's registered number, it is Budi's report.

### 5.3 Response Rules

The helper responds only when:
- mentioned/tagged;
- receiving a report;
- running a scheduled message;
- asking a clarification;
- waiting for a confirmation;
- acknowledging a processed official action.

It does not join casual conversation.

### 5.4 Candidate Context

An untagged message may be retained as candidate context for 48 hours. It does not mutate official state.

---

## 6. Permission Model

### 6.1 All Active Members May

- submit reports;
- query all division tasks and reports;
- view another member's report;
- update a task they are assigned to or have contributed to;
- report completion;
- reopen a task they previously worked on;
- propose handoff;
- propose cancellation;
- set their own leave/sick status;
- confirm a candidate task from their own report.

### 6.2 Administrators May

- create tasks, change title, project, deadline, assignments;
- cancel tasks;
- modify another member's work;
- approve cancellation;
- resolve conflict;
- add, deactivate, transfer, or reactivate members;
- edit allowed operational fields in Google Sheets.

Permission checks must be deterministic and tested.

---

## 7. Task Model

### 7.1 Core Fields

```text
task_id, title, normalized_title, project_id, project_state,
status, deadline_label, must_finish_before, latest_update,
created_by_member_id, created_at, updated_at, stale_since,
confirmation_state, pending_action_type, pending_action_state,
needs_reassignment, source_reference, version
```

### 7.2 Main Statuses

```text
active, active_unreviewed, in_progress, blocked, paused,
stale, status_conflict, done, cancelled, overdue
```

### 7.3 Pending/Transient States

```text
draft, waiting_confirmation, handoff_pending,
cancellation_pending, project_confirmation_pending, candidate_task
```

Do not overload a single status column. Model pending actions separately.

---

## 8. Deadline Semantics

Business rule: **"Deadline tanggal 10" means "must be completed by tanggal 9 at 23:59 Asia/Jakarta."**

Store both `deadline_label` and `must_finish_before`.

Reminder rules:
- H-3: included in morning summary;
- H-1: special attention;
- Last finish day 08:00: highlighted as due today;
- Last finish day 16:00: dedicated reminder;
- After 23:59: overdue.

A task without a deadline remains active. The helper asks once and lists it under "deadline belum ditentukan."

---

## 9. Report Rules

### 9.1 Reporting Day

A reporting day starts at **10:00 Asia/Jakarta**.

```text
Day N 10:00–Day N+1 09:59  =  reporting day for Day N
```

### 9.2 Report Header

Valid report requires a clear header: `report`, `report Agas`, `daily report`, etc.

A bullet list without header asks for confirmation.

### 9.3 Report Content

Each report item extracts to: `activity`, `result`, `obstacle`, `status`.

Classification: `worked_on`, `in_progress`, `testing`, `blocked`, `done`, `unknown`.

**"Test docking" is testing, not done.**

### 9.4 Reminders

Monday through Saturday:
- 20:00: first missing-report reminder;
- 22:30: final missing-report reminder.

### 9.5 Revisions

Corrections append a new revision, never overwrite.

### 9.6 No-Activity Report

A report saying no work was done: `pending_admin_confirmation`. Until approved, the member is still considered missing.

### 9.7 Acknowledgment

A valid report receives a concise acknowledgment: `"Report Agas tercatat: 5 aktivitas, 2 update task, 1 task selesai, 1 candidate task."`

---

## 10. Candidate Tasks and Matching

An unmatched report activity creates a candidate task.

Options: `buat task`, `hanya aktivitas`, `gabungkan dengan task existing`.

Appears in at most 3 morning summaries. If unanswered, becomes `active_unreviewed`.

Similar tasks must not be auto-merged. Show candidates and request decision.

If a completed task appears again, create a new candidate (rework, follow-up, activity only). Do not silently reopen.

---

## 11. Scheduled Outputs

### 11.1 Morning Summary (Mon–Sat 08:00)

Include: active tasks, due today, overdue, blocked, active obstacles, stale, paused, no deadline, no project, completed yesterday.

**Owner decision (2026-08-06):** v1 does NOT auto-tag/@mention members in scheduled messages
(morning summary, reminders). A brand-new WhatsApp number sending scheduled mass-mentions is a
known ban-risk pattern. Members are listed by name in plain text; if an admin wants to notify
everyone, WhatsApp's native `@all` group mention covers that manually. Automated per-member
tagging may be added in a later phase once the number has an established history.

### 11.2 Deadline Reminder (16:00 on last allowed finish day)

### 11.3 Weekly Wrap-up

- Saturday 10:15: send provisional wrap-up to WhatsApp, save to Sheets;
- Sunday 10:05: finalize after Saturday's report window closes at 09:59.

---

## 12. Natural-Language Queries

All active members may ask: `@helper tugas hari ini apa?`, `@helper deadline terdekat apa?`, `@helper pekerjaan Agas apa?`, `@helper siapa yang belum report?`, etc.

The LLM parses intent and parameters. The backend executes authorized database queries.

**Do not answer operational questions from LLM memory.**

---

## 13. Google Sheets Design

One spreadsheet per year: `Helper Divisi Electrical — 2026`.

Tabs: DASHBOARD, TASKS, TASK_ASSIGNEES, TASK_HISTORY, DAILY_REPORTS, REPORT_ITEMS, DAILY_SUMMARIES, WEEKLY_SUMMARIES, MEMBERS, PROJECTS, SETTINGS, SYNC_LOG.

Permissions: service account editor, 3 admins editor, anyone-with-link viewer.

**Public link risk:** Because the link may be forwarded, never expose phone numbers, JIDs, auth data, source message IDs, technical logs, model internals, private health reasons, or temporary candidate context.

**Owner decision (2026-08-06):** two-way sync on TASKS (title, project, status, deadline, assignees,
notes, active) is confirmed as designed — chief review had flagged this as added complexity for
limited benefit and suggested export-only; owner reviewed and chose to keep two-way editing for
admin convenience. Conflict detection (ARCHITECTURE_PROPOSAL.md §8) remains required, not optional.

---

## 14. Member Lifecycle

Member fields: `member_id`, `preferred_name`, `aliases`, `role`, `membership_status`, `start_date`, `end_date`, `report_required`, `created_at`, `updated_at`.

Private mapping: `member_id ↔ current WhatsApp JID ↔ previous JIDs`.

Statuses: `pending`, `active`, `inactive`, `transferred`, `resigned`, `removed`.

**Never hard-delete a member.** Preserve task history, reports, contribution, audit events.

---

## 15. Attendance and Saturday Rules

Members can set: `izin`, `cuti`, `sakit`.

Saturday may use: `not_scheduled` — not reminded, not counted as missing, may still submit.

---

## 16. Edited/Deleted Messages and Outage

- **Edited:** detect edit, calculate differences, ask for confirmation. Do not silently mutate.
- **Deleted:** do not delete associated task. Ask whether to cancel.
- **Outage:** no automatic backlog processing. Announce outage interval, request resubmission. Allow manual reprocessing of specific messages.

---

## 17. Data Model (Suggested)

```text
members, member_identifiers, member_aliases, member_availability,
projects, project_aliases, tasks, task_assignees, task_contributors,
task_events, task_obstacles, daily_reports, report_revisions,
report_items, candidate_tasks, pending_actions, incoming_messages,
message_context, processed_message_keys, daily_summaries,
weekly_summaries, scheduled_jobs, sheets_sync_events,
connection_outages, llm_invocations, audit_events
```

Use immutable or append-only event records for history. Use database transactions for every official state change.

---

## 18. Reliability Requirements

Required: idempotent message processing, bounded retries, dead-letter handling, database transactions, persistent WhatsApp session, startup recovery, graceful shutdown, health/readiness endpoints, structured logs, correlation IDs, backup and tested restore, clock/timezone correctness.

**Do not treat a successful WhatsApp send as proof of successful database mutation, or vice versa.**
