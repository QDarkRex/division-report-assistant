# WhatsApp Division Helper — Implementation Roadmap

> **Document type:** Phased implementation plan  
> **Status:** Phase 0 in progress (documentation only)  
> **See also:** [MASTER_SPEC.md](MASTER_SPEC.md), [ARCHITECTURE_PROPOSAL.md](ARCHITECTURE_PROPOSAL.md), [REPOSITORY_REVIEW.md](REPOSITORY_REVIEW.md)

---

## Phase 0 — Documentation and Repository Review

**Status:** ✅ This PR  
**Deliverables:**
- [MASTER_SPEC.md](MASTER_SPEC.md) — reviewed specification
- [REPOSITORY_REVIEW.md](REPOSITORY_REVIEW.md) — infrastructure audit and fit analysis
- [ARCHITECTURE_PROPOSAL.md](ARCHITECTURE_PROPOSAL.md) — container/module/data-flow design
- [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) — security review
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) — this document
- [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) — test plan

**Exit criteria:**
- All 6 documents reviewed and pushed;
- owner has resolved open questions (especially cloud LLM privacy);
- owner has allocated DeepSeek API key and Google service account.

---

## Phase 1 — Core Deterministic Domain

**Goal:** Implement the full task/report/member domain with zero LLM dependency.  
**Duration estimate:** 2–3 weeks

### Deliverables

- Node.js + Fastify project scaffold (`package.json`, `tsconfig.json`, Dockerfile);
- Drizzle ORM schema for all tables (see [MASTER_SPEC.md §17](MASTER_SPEC.md#17-data-model-suggested));
- Member service (CRUD, JID mapping, aliases, lifecycle);
- Project service (CRUD, confirmation workflow);
- Task service (full state machine, assignments, contributions, deadlines);
- Report storage (daily reports, revisions, items, obstacles);
- Permission engine (member vs admin, deterministic checks);
- Deadline calculation (the special "tanggal 10" rule, Asia/Jakarta timezone);
- Unit tests for all services (synthetic data, no real group data);
- Docker Compose skeleton on the server;
- CI: add Node.js test step to GitHub Actions workflow.

### Exit Criteria

- All unit tests pass;
- Docker container starts, `/healthz` returns 200;
- task state machine handles all transitions from [MASTER_SPEC §7](MASTER_SPEC.md#7-task-model);
- deadline calculation handles all edge cases from [MASTER_SPEC §8](MASTER_SPEC.md#8-deadline-semantics);
- permission checks cover all rules from [MASTER_SPEC §6](MASTER_SPEC.md#6-permission-model).

---

## Phase 2 — LLM Parsing

**Goal:** Integrate DeepSeek V4 Flash for message classification and extraction.  
**Duration estimate:** 2–3 weeks  
**Prerequisite:** DeepSeek API key allocated; owner has approved cloud LLM privacy decision.

### Deliverables

- Add `deepseek-v4-flash` model alias to LiteLLM config;
- Redaction layer (replace phone numbers, JIDs with internal IDs before LLM calls);
- Zod schemas for all LLM output contracts:
  - message classification (daily_report, query, noise, command, etc.);
  - report extraction (activity, result, obstacle, status, task candidates);
  - query intent parsing;
  - clarification generation;
- LLM client with:
  - non-thinking mode by default;
  - thinking mode only on explicit trigger;
  - bounded retries with repair prompt;
  - structured JSON output;
  - token usage and cost recording per feature;
- Cost telemetry table (`llm_invocations`);
- Cost dashboard queries (daily/monthly usage, cost by feature, projected exhaustion);
- Budget controls (soft/hard monthly limits, degradation behavior);
- Test corpus: 100–200 representative Indonesian messages;
- Integration tests: message → classification → extraction → validated output.

### Exit Criteria

- A normal report uses exactly one LLM call;
- obvious noise produces zero LLM calls;
- invalid JSON retry is bounded (max 3 attempts);
- thinking mode is not the default;
- cost telemetry matches within documented tolerance;
- soft-limit degradation works;
- hard-limit degradation works;
- 100+ test messages classified correctly.

---

## Phase 3 — Scheduler and Summaries

**Goal:** Implement all scheduled outputs using pg-boss.  
**Duration estimate:** 1–2 weeks  
**Prerequisite:** Phase 1 complete.

### Deliverables

- pg-boss integration with job definitions for:
  - Morning summary (Mon–Sat 08:00 Asia/Jakarta);
  - Deadline reminder (16:00 on last finish day);
  - First missing-report reminder (20:00);
  - Final missing-report reminder (22:30);
  - Stale task detection (daily);
  - Weekly provisional wrap-up (Saturday 10:15);
  - Weekly final wrap-up (Sunday 10:05);
  - Candidate task timeout (3 morning summaries);
  - Project confirmation timeout (3 morning summaries);
  - Candidate context cleanup (48 hours);
- Morning summary generation (active tasks, due today, overdue, blocked, stale, paused, completed yesterday);
- Deadline reminder generation;
- Missing-report detection and reminder;
- Stale task detection (7 days without update);
- Timezone tests (Asia/Jakarta, DST-adjacent dates);
- pg-boss job recovery on container restart.

### Exit Criteria

- All scheduled jobs fire at correct times;
- timezone handling is correct;
- missed jobs are recovered after restart;
- morning summary includes all required sections;
- stale task detection fires after exactly 7 days.

---

## Phase 4 — Google Sheets

**Goal:** One-way export from PostgreSQL to Google Sheets.  
**Duration estimate:** 1–2 weeks  
**Prerequisite:** Google service account created and credentials stored at `/opt/app/secrets/division-report-assistant/sheets-service-account.json`.

### Deliverables

- Google Sheets API client;
- Yearly workbook creation (`Helper Divisi — 2026`);
- Tab structure (12 tabs per [MASTER_SPEC §13](MASTER_SPEC.md#13-google-sheets-design));
- One-way export: PostgreSQL → append-only tabs;
- Data minimization: no JIDs, no phone numbers, no PII;
- Limited two-way sync for admin-editable tabs (title, project, status, deadline, assignees, notes, active);
- Conflict detection and admin notification;
- Audit events for every Sheets edit;
- Sync state tracking (pending/applied/rejected).

### Exit Criteria

- All tabs populated with sanitized data;
- public viewer link contains no PII;
- admin edits are detected and applied correctly;
- Sheets outage does not stop WhatsApp processing;
- sync log records every operation.

---

## Phase 5 — WhatsApp Sandbox

**Goal:** Connect to WhatsApp using Baileys with a dedicated test number.  
**Duration estimate:** 1–2 weeks  
**Prerequisite:** Dedicated WhatsApp number purchased; Baileys adapter interface defined.

### Deliverables

- Baileys adapter implementing `WhatsAppConnector` interface;
- Persistent session storage (volume mount);
- Pairing code / QR recovery documentation;
- Connection status monitoring;
- Reconnect with exponential backoff;
- Test with dedicated test number and test group;
- Tests for: pairing, reconnect, mentions, replies, sender identity, group identity, edits, deletes, outage, deduplication, rate limiting.

### Exit Criteria

- WhatsApp connects and maintains session;
- reconnect works after container restart;
- sender identity is correctly resolved from JID;
- edits and deletes are detected;
- outage is logged and recovery works;
- rate limiting prevents spam.

---

## Phase 6 — Observe-Only Pilot

**Goal:** Deploy in the real division group without automatic mutation.  
**Duration estimate:** 2–4 weeks  
**Prerequisite:** All previous phases complete; owner approval.

### Behavior

- Reads all group messages;
- Records proposed interpretations;
- Does NOT create tasks, update status, or send responses;
- Compares proposed interpretations with admin decisions;
- Generates daily accuracy report for owner review.

### Metrics to Measure

- message classification precision;
- report detection recall;
- task-match accuracy;
- status accuracy;
- clarification rate;
- false mutations prevented;
- LLM cost per day;
- response latency.

### Exit Criteria

- ≥90% message classification precision;
- ≥85% report detection recall;
- ≥80% task-match accuracy;
- owner approves moving to Phase 7;
- LLM cost within budget targets.

---

## Phase 7 — Gradual Activation

**Goal:** Enable features one at a time in the real group.  
**Duration estimate:** 2–4 weeks  
**Prerequisite:** Phase 6 owner approval.

### Activation Order

1. **Queries** — members can ask `@helper` questions (read-only, no state mutation);
2. **Morning summary** — scheduled summary at 08:00;
3. **Report ingestion** — accept and store daily reports;
4. **Task updates** — allow task status changes from reports;
5. **Report reminders** — missing-report reminders at 20:00/22:30;
6. **Deadline reminders** — deadline approaching notifications;
7. **Candidate tasks** — auto-create candidate tasks from unmatched activities;
8. **Google Sheets limited edits** — enable admin two-way sync;
9. **Member lifecycle** — add/deactivate/reactivate members;
10. **Weekly wrap-up** — Saturday provisional + Sunday final.

### Exit Criteria

Each feature must pass its acceptance tests from [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) before the next feature is activated.

---

## Post-Activation

- Monitor for 2 weeks with all features active;
- Collect owner and admin feedback;
- Tune classification accuracy, prompt templates, cost controls;
- Document lessons learned;
- Consider: additional groups, advanced features, local LLM migration.
