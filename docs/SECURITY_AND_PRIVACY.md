# WhatsApp Division Helper — Security and Privacy Review

> **Document type:** Security and privacy assessment  
> **Status:** Phase 0 — documentation only  
> **See also:** [MASTER_SPEC.md](MASTER_SPEC.md), [REPOSITORY_REVIEW.md](REPOSITORY_REVIEW.md)

---

## 1. Threat Model

### 1.1 Assets

| Asset | Sensitivity | Location |
|-------|------------|----------|
| WhatsApp session/auth state | High | `/opt/app/data/division-report-assistant/` |
| Group message content | Medium-High | PostgreSQL `whatsapp_division` |
| Member phone numbers/JIDs | High | PostgreSQL `whatsapp_division` |
| Task and report data | Medium | PostgreSQL `whatsapp_division` |
| LLM API keys | High | `/opt/app/secrets/division-report-assistant/` |
| Google service account | High | `/opt/app/secrets/division-report-assistant/` |
| Audit logs | Medium | PostgreSQL `whatsapp_division` |
| Google Sheets data | Medium | Google Cloud (viewer-accessible) |

### 1.2 Actors

| Actor | Capability | Threat |
|-------|-----------|--------|
| Division member | Send WhatsApp messages, mention helper | Prompt injection, data leakage |
| Admin | All member capabilities + task management | Accidental data exposure via Sheets |
| External reader | View Google Sheets via public link | See PII if Sheets not sanitized |
| WhatsApp protocol change | Break Baileys connector | Denial of service |
| DeepSeek API | Receives sanitized text | Data retention, potential breach |
| Container compromise | Access to volumes and secrets | Full data exposure |

---

## 2. Secret Management

### 2.1 Pattern

Follow the existing repo convention:

```text
/opt/app/secrets/division-report-assistant/
├── runtime.env          # DEEPSEEK_API_KEY, LLM_BUDGET_*, etc.
├── google-service-account.json   # Google Sheets service account
└── baileys-session/      # WhatsApp auth state (auto-created)
```

### 2.2 Rules

- **No secrets in Git** — `.env`, `.env.*`, service-account JSON all in `.gitignore`;
- **`.env.example` with placeholders only** — no real values;
- **Secrets mounted as Docker `env_file`** — not baked into images;
- **Service account JSON** mounted read-only as a Docker secret;
- **Baileys session** stored on a named volume, not in Git;
- **Masked injection** — use PowerShell helpers (existing pattern) for secret setup on the server.

---

## 3. WhatsApp Session Security

### 3.1 Storage

- Baileys auth state persisted to `/opt/app/data/division-report-assistant/baileys-session/`;
- Volume mounted read-write only to the WDH container;
- Not included in Restic backup (regenerable via re-pair);
- Container runs with `read_only: true` except for this volume.

### 3.2 Recovery

- Documented pairing-code recovery procedure;
- QR code fallback documented;
- Session invalidation triggers admin notification via Telegram (existing alert pattern).

---

## 4. Cloud LLM Privacy (Critical)

### 4.1 What Is Sent to DeepSeek

When a WhatsApp message requires LLM processing, the following is sent:

| Data | Sent to LLM? | Treatment |
|------|-------------|-----------|
| Message text | Yes (sanitized) | Phone numbers and JIDs redacted |
| Sender phone number | **No** | Replaced with internal member_id |
| Sender JID | **No** | Replaced with internal member_id |
| Group metadata | **No** | Not sent |
| Task titles/descriptions | Only if relevant | From database, not raw messages |
| Previous messages | Bounded context window | Recent relevant messages only |

### 4.2 Redaction Layer

**Revised 2026-08-06 (chief-review follow-up).** The original wording of this section ("replace member names where possible," "strip any content matching known PII patterns") named no concrete mechanism for the second and fourth steps — phone numbers and JIDs are structured and regex-redactable, but free-text PII (a client's name, an incident description, a `sakit` reason) is not, and claiming it would be stripped by "known PII patterns" without defining those patterns was not an implementable mitigation.

The redaction layer runs **before** any text reaches the LLM, using two mechanisms, not one:

1. **Regex, for structured identifiers**: `+62XXXXXXXXXX` patterns → `[PHONE_REDACTED]`; `XXXXXXXXXX@s.whatsapp.net` JID patterns → `[JID_REDACTED]`.
2. **Dictionary lookup against known entities in our own database**, not general-purpose NER: build the redaction dictionary from `members.preferredName` + `member_aliases.alias` and `projects.name` + `project_aliases.alias` (queried via `resolveMembersByNameOrAlias` / `resolveProjectsByNameOrAlias`, `deployments/division-report-assistant/src/members/service.ts` and `.../projects/service.ts`), and replace exact/case-insensitive matches with the member's/project's internal ID before the text reaches the LLM.
3. Log redaction count (matches found, by category) for audit — no raw matched text logged.

**Explicit scope limit, not a gap left unaddressed:** dictionary lookup only redacts entities *already registered* in `members`/`projects`. It does **not** catch:
- a client company/site name that was never entered as a `project` (project names are the only "client name" concept this system has — there is no separate client entity in the data model);
- free-text incident descriptions, obstacle details, or `member_availability.note` health reasons — these remain in the report text sent to DeepSeek essentially as written;
- a person's name typed in a report who isn't a division member (e.g. a supervisor, a client contact).

**Owner decision (2026-08-06):** this residual exposure is accepted. Report/obstacle/note content — beyond registered member and project names — is sent to DeepSeek's cloud API without further redaction. This is a narrower, more honest claim than the original wording ("client names, PII replaced") implied.

### 4.3 Privacy Decision — OWNER APPROVED 2026-08-06

**Decision:** DeepSeek V4 Flash is approved as the primary LLM provider, with mandatory mitigations.

**Rationale:** For a work division group (Electrical Division), the operational value of structured task/report extraction outweighs the privacy risk, provided mitigations are enforced. Group content is operational (task progress, obstacles, schedules) — not personal or legally sensitive.

**Mandatory mitigations (non-negotiable):**

| # | Mitigation | Enforcement |
|---|-----------|------------|
| 1 | **Redaction layer** — phone numbers/JIDs (regex) and registered member/project names (dictionary lookup) stripped before LLM. Does NOT strip free-text PII in report/obstacle/note content — see §4.2. | Code-level, tested |
| 2 | **Minimal context** — only send the relevant message excerpt, never full history | Architectural |
| 3 | **Audit log** — every LLM request logged with feature, token count, latency | Database table `llm_invocations` |
| 4 | **Provider isolation** — adapter pattern means DeepSeek can be swapped if policy changes | Architecture (ADR-0010) |
| 5 | **Monthly review** — owner reviews LLM audit log monthly for first 3 months | Manual |

**Provider risk acknowledgment:**
- DeepSeek is a China-based AI company;
- data may be processed in China;
- redaction removes phone numbers, JIDs, and registered member/project names — it does NOT remove free-text report content (see §4.2's explicit scope limit); the owner has accepted this residual exposure;
- if policy changes, the adapter interface allows swapping to another provider without refactoring the service layer. Note: a 2026-08-06 pricing check found Gemini 2.5 Flash (the main alternative considered on privacy grounds) costs ~2x DeepSeek's cache-miss input rate and ~8.9x its output rate — switching provider for privacy reasons has a real, large cost consequence, not a neutral one.

**ADR:** See [ADR-0010-deepseek-llm-privacy.md](../../decisions/ADR-0010-deepseek-llm-privacy.md).

---

## 5. Google Sheets Security

### 5.1 Access Control

```text
Service account:  Editor (automated sync)
3 admins:        Editor (manual corrections)
Anyone with link: Viewer (read-only)
```

### 5.2 Data Minimization

**Never expose in Sheets:**

- Phone numbers;
- WhatsApp JIDs;
- Auth/session data;
- Source message IDs;
- Technical logs;
- Model confidence internals;
- Private health/family reasons;
- Temporary candidate context.

Use stable member IDs and display names only.

### 5.3 Public Link Risk

Because the viewer link may be forwarded:
- Sheets content must be safe for external eyes;
- no internal project codenames if they are sensitive;
- no member personal information beyond name and role;
- consider: is a public link appropriate, or should access be restricted to named Google accounts?

### 5.4 Two-Way Sync Audit

Every accepted Sheets edit creates an audit event:
- who made the edit (admin Google account);
- what was changed (before/after);
- when (timestamp);
- whether it was applied or rejected.

---

## 6. Prompt Injection Prevention

### 6.1 Threat

A malicious or careless group member could craft a WhatsApp message designed to manipulate the LLM into:
- executing unauthorized actions;
- revealing internal data;
- modifying tasks or reports incorrectly.

### 6.2 Controls

1. **Distinguish user content from system instructions** — LLM prompts use clear delimiters;
2. **Zod validation on every LLM output** — only validated data reaches the service layer;
3. **Permission checks after LLM classification** — the LLM classifies intent, but the service layer enforces authorization;
4. **Never allow message text to choose** arbitrary database queries, tools, files, URLs, or shell commands;
5. **Rate limiting** — limit helper command frequency per member;
6. **Bounded context** — never send the full task database or group history to the LLM.

### 6.3 Testing

- Unit tests with adversarial message patterns (see [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md));
- fuzz testing of LLM output schemas;
- verify that adversarial prompts do not bypass permission checks.

---

## 7. Database Security

### 7.1 Isolation

```text
PostgreSQL instance: shared (postgres)
Database: whatsapp_division (isolated from every other database on the instance)
User: whatsapp_division_user (separate credentials)
```

- `whatsapp_division_user` has full access to `whatsapp_division` only;
- cannot read or write any other database on the instance;
- credentials stored at `/opt/app/secrets/division-report-assistant/database.env`.

### 7.2 Network

- PostgreSQL bound to Docker internal network only;
- not exposed to host or LAN;
- WDH container connects via Docker network.

### 7.3 Backup

- `pg_dump` for `whatsapp_division` added to Restic backup flow;
- backup includes member data, tasks, reports, audit events;
- backup excludes WhatsApp session (regenerable) and LLM API keys.

---

## 8. Audit Logging

### 8.1 What Is Logged

Every official state change creates an audit event:

```text
event_id, event_type, actor_member_id, target_type, target_id,
before_state, after_state, source (whatsapp/sheets/api),
timestamp, correlation_id
```

### 8.2 Event Types

- task_created, task_updated, task_cancelled, task_reopened;
- report_submitted, report_revised;
- member_activated, member_deactivated;
- sheets_edit_applied, sheets_edit_rejected;
- llm_invocation, llm_budget_alert;
- whatsapp_outage, whatsapp_reconnect;
- permission_denied.

### 8.3 Retention — Audit Events

Audit events are append-only and permanent. They are part of the backup scope.

### 8.4 Retention — Raw Message Text (owner decision, 2026-08-06)

`incoming_messages.raw_text` is NOT permanent, unlike audit events — chief review flagged that
storing every group message's raw text forever contradicts this project's own data-minimization
stance (candidate context already expires after 48h per §5.4).

**Decision:** `raw_text` is nulled 30 days after `received_at` by a scheduled job (Phase 3, pg-boss).
The row itself, `whatsapp_message_key`, `sender_jid`, timestamps, and `is_replayed` are kept
indefinitely (needed for dedup/idempotency and the audit trail) — only the message body is redacted.
Extracted structured data (tasks, reports, report_items) is unaffected — that data already lives in
its own tables independent of the source message text.

---

## 9. Rate Limiting

- Per-member command rate limiting (configurable);
- prevent rapid-fire message processing;
- prevent LLM cost abuse from a single member;
- alert on unusual patterns (potential abuse or bot compromise).

---

## 10. Container Hardening

Following existing repo conventions:

```yaml
restart: unless-stopped
read_only: true
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp:rw,noexec,nosuid,nodev,size=64m
```

Additional for WDH:
- volume mount for Baileys session (read-write, named volume only);
- volume mount for logs (optional, for structured log export);
- no host network (use Docker internal networking);
- resource limits: 512 MB RAM, 0.5 CPU, 256 PIDs.

---

## 11. Incident Response

| Scenario | Response |
|----------|----------|
| WhatsApp session compromised | Re-pair immediately, alert admin, audit recent actions |
| LLM API key leaked | Rotate key, check DeepSeek usage dashboard, alert admin |
| Google service account leaked | Rotate key, check Sheets activity, alert admin |
| Container compromised | Stop container, audit volumes, rebuild from clean image |
| Data breach detected | Stop service, preserve audit log, notify owner, assess scope |
