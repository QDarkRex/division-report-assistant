# WhatsApp Division Helper — Acceptance Tests

> **Document type:** Test plan  
> **Status:** Phase 0 — planning only, no implementation  
> **See also:** [MASTER_SPEC.md](MASTER_SPEC.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)

---

## Test Conventions

- All tests use the project's chosen test framework (Node.js: Vitest or Jest recommended);
- synthetic data only — no real WhatsApp group data;
- each test is independent and idempotent;
- timezone-sensitive tests use explicit `Asia/Jakarta` timestamps;
- LLM-dependent tests use mocked LLM responses (Phase 2+).

---

## 1. Identity and Permission Tests

### 1.1 Member Identity

| Test | Expected |
|------|----------|
| Two members with the same display name have separate profiles | PASS — different member_ids |
| Display name change does not lose profile history | PASS — old name becomes alias |
| Typing a name that matches a member resolves to that member | PASS |
| Typing a name that matches no member returns unknown | PASS |
| Phone number change retains the same member_id | PASS — old JID deactivated, new JID linked |

### 1.2 Permissions

| Test | Expected |
|------|----------|
| Non-admin cannot create a task directly | DENIED |
| Non-admin cannot change another member's deadline | DENIED |
| Non-admin cannot cancel a task (creates proposal) | PENDING |
| Admin can create, update, cancel tasks | ALLOWED |
| Admin can activate/deactivate members | ALLOWED |
| Inactive member receives no reminders | PASS — excluded from reminder list |
| Reactivated member retains all history | PASS — no data loss |

---

## 2. Report Processing Tests

### 2.1 Report Day

| Test | Input | Expected Reporting Day |
|------|-------|----------------------|
| Report at 10:00 | 2026-08-07 10:00 WIB | 7 August |
| Report at 09:59 | 2026-08-07 09:59 WIB | 6 August (late) |
| Report at 16:59 | 2026-08-07 16:59 WIB | 7 August (early) |
| Report at 17:00 | 2026-08-07 17:00 WIB | 7 August (normal) |
| Report at 23:59 | 2026-08-07 23:59 WIB | 7 August (normal) |
| Report at 00:00 | 2026-08-08 00:00 WIB | 7 August (late) |

### 2.2 Report Content

| Test | Expected |
|------|----------|
| Report with header "report" is processed | PASS |
| Report with header "report Agas" is processed, attributed to Agas's member_id | PASS |
| Bullet list without report header asks for confirmation | PASS — helper asks |
| "test docking charge" is classified as `testing`, not `done` | PASS |
| "Sudah selesai dan final" is classified as `done` | PASS |
| Ambiguous completion requires clarification | PASS — helper asks |
| Results and obstacles are stored independently | PASS |
| Report correction appends a revision, original preserved | PASS |

### 2.3 No-Activity Report

| Test | Expected |
|------|----------|
| "Tidak ada aktivitas hari ini" creates pending_admin_confirmation | PASS |
| Member with no-activity report still receives reminders until approved | PASS |
| Admin approves no-activity report | PASS — member marked as reported |

### 2.4 Acknowledgment

| Test | Expected |
|------|----------|
| Valid report receives concise acknowledgment with counts | PASS — e.g., "5 aktivitas, 2 update task" |

---

## 3. Task Lifecycle Tests

### 3.1 Task Creation and Matching

| Test | Expected |
|------|----------|
| New activity not matching any existing task creates a candidate task | PASS |
| Similar tasks are NOT auto-merged — candidates shown for decision | PASS |
| Completed task appearing again creates a new candidate (rework/follow-up) | PASS — original stays `done` |
| Candidate task appears in morning summary until confirmed or timeout | PASS |
| Candidate task unanswered after 3 morning summaries becomes `active_unreviewed` | PASS |
| Author can confirm their own candidate task | PASS |
| Unrelated regular member cannot confirm another's candidate | DENIED |

### 3.2 State Transitions

| Test | From | Trigger | Expected To |
|------|------|---------|-------------|
| Normal progress | active | member reports work | in_progress |
| Completion | in_progress | "sudah selesai" | done |
| Block report | in_progress | obstacle report | blocked |
| Block resolution | blocked | obstacle resolved | in_progress |
| Stale detection | in_progress | 7 days no update | stale |
| Admin cancel | any | admin cancellation | cancelled |
| Member cancel proposal | active | member request | cancellation_pending |
| Conflict detection | in_progress | conflicting updates | status_conflict |
| Reopen | done | member request | active |

### 3.3 Deadline

| Test | Expected |
|------|----------|
| "Deadline tanggal 10" sets `must_finish_before` to 10th 00:00 WIB (i.e., 9th 23:59) | PASS |
| Task without deadline remains active indefinitely | PASS |
| Helper asks once for deadline, then lists under "belum ditentukan" | PASS |
| H-3 reminder includes task in morning summary | PASS |
| H-1 reminder flagged as special attention | PASS |
| Last finish day 08:00 highlighted as "due today" | PASS |
| Last finish day 16:00 sends dedicated reminder | PASS |
| After 23:59 task marked overdue | PASS |

### 3.4 Edge Cases

| Test | Expected |
|------|----------|
| Handoff proposal requires acceptance or admin confirmation | PENDING until accepted |
| Conflict status is not silently overwritten | PASS — stays `status_conflict` until admin resolves |
| Paused task without review date appears in every morning summary | PASS |
| Member departure with active assignments creates reassignment handling | PASS — `needs_reassignment: true` |
| Task with multiple assignees — all listed by name in reminders (v1: no @mention, see MASTER_SPEC §11.1) | PASS |

---

## 4. Reliability Tests

### 4.1 Deduplication

| Test | Expected |
|------|----------|
| Duplicate WhatsApp event (same message ID) is processed once | PASS |
| Edited message creates a new event, original preserved | PASS |
| Deleted message does not delete associated task | PASS — task preserved |

### 4.2 LLM Failure

| Test | Expected |
|------|----------|
| LLM returns invalid JSON → bounded retry with repair prompt | Max 3 attempts |
| LLM returns invalid JSON after all retries → ask user for clarification | PASS |
| LLM invalid JSON does NOT mutate any database state | PASS |
| LLM timeout → queue for later, do not lose message | PASS |
| LLM budget exhausted → deterministic processing only | PASS |

### 4.3 Outage

| Test | Expected |
|------|----------|
| WhatsApp outage is recorded with interval | PASS |
| No automatic backlog processing on reconnect | PASS |
| Outage announced in group after reconnect | PASS |
| Manual reprocessing via `@helper proses pesan yang saya reply ini` works | PASS |

### 4.4 Process Restart

| Test | Expected |
|------|----------|
| pg-boss jobs survive container restart | PASS — recovery on startup |
| Scheduled outputs not missed after restart | PASS — catch-up logic |
| Baileys session persists across restart | PASS |

### 4.5 Backup and Restore

| Test | Expected |
|------|----------|
| pg_dump + restore produces clean test environment | PASS |
| Restored database has all tasks, reports, members, audit events | PASS |
| No data loss from backup/restore cycle | PASS |

---

## 5. Privacy Tests

### 5.1 Sheets Sanitization

| Test | Expected |
|------|----------|
| Sheets TASKS tab contains no phone numbers | PASS |
| Sheets TASKS tab contains no JIDs | PASS |
| Sheets MEMBERS tab uses display names, not phone numbers | PASS |
| Sheets contains no auth/session data | PASS |
| Sheets contains no source message IDs | PASS |
| Public viewer link cannot edit any tab | PASS |

### 5.2 LLM Redaction

| Test | Expected |
|------|----------|
| Phone numbers are replaced before LLM call | PASS — `[PHONE_REDACTED]` |
| JIDs are replaced before LLM call | PASS — `[JID_REDACTED]` |
| Member names replaced with internal IDs where possible | PASS |
| LLM request contains no raw phone number | PASS |
| LLM request contains no JID | PASS |

### 5.3 Logging

| Test | Expected |
|------|----------|
| Application logs contain no secrets | PASS |
| Application logs contain no phone numbers | PASS |
| Application logs contain no JIDs | PASS |

---

## 6. LLM Cost and Token Efficiency Tests

### 6.1 Cost Controls

| Test | Expected |
|------|----------|
| Normal report uses exactly 1 LLM call | PASS |
| Simple deterministic query uses 0 LLM calls after intent parsed | PASS |
| Obvious noise (sticker, reaction, greeting) produces 0 LLM calls | PASS |
| Thinking mode is NOT the default | PASS |
| Retry count is bounded (max 3) | PASS |
| Token usage and estimated cost are recorded per feature | PASS |
| Monthly soft limit triggers degradation | PASS |
| Monthly hard limit triggers severe degradation | PASS |
| Budget alerts sent to administrators | PASS |
| No budget state causes silent data loss | PASS |
| Projected exhaustion date is calculated from rolling average | PASS |

### 6.2 Token Efficiency

| Test | Expected |
|------|----------|
| Complete task database is never sent for ordinary task matching | PASS |
| Full group history is never sent | PASS |
| Context window is bounded (configurable max) | PASS |
| Cache eligibility: stable system prompts reused across calls | PASS |
| Cost by feature is trackable (message_classification, report_parsing, etc.) | PASS |

---

## 7. Integration Tests (Phase 6+)

### 7.1 End-to-End Report Flow

```text
1. Simulate WhatsApp message: "report\n- pekerjaan: test docking charge\n  hasil: charging berhasil\n  kendala: koneksi Wi-Fi tidak stabil"
2. Verify: message ingested, classified as daily_report
3. Verify: report stored with correct reporting day
4. Verify: activity extracted (test docking charge)
5. Verify: result extracted (charging berhasil)
6. Verify: obstacle extracted (koneksi Wi-Fi tidak stabil, blocking)
7. Verify: task candidate created or matched
8. Verify: acknowledgment sent
9. Verify: audit event created
10. Verify: LLM cost recorded
```

### 7.2 End-to-End Task Lifecycle

```text
1. Admin creates task via WhatsApp
2. Member reports progress
3. Member reports completion
4. Verify: task status transitions correctly
5. Verify: morning summary includes task appropriately
6. Verify: Sheets export reflects current state
7. Verify: all audit events recorded
```

### 7.3 End-to-End Scheduled Output

```text
1. Set system clock to 07:55 WIB
2. Verify: morning summary job fires at 08:00
3. Verify: summary includes all required sections
4. Verify: correct member names are listed (no @mention in v1)
5. Verify: summary is also exported to Sheets
```
