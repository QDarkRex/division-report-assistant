# WhatsApp Division Helper — Architecture Proposal

> **Document type:** Architecture design  
> **Status:** Phase 0 — documentation only  
> **Target:** TypeScript + Fastify modular monolith on Docker  
> **See also:** [MASTER_SPEC.md](MASTER_SPEC.md), [REPOSITORY_REVIEW.md](REPOSITORY_REVIEW.md)

---

## 1. Context Diagram

```mermaid
C4Context
    title WhatsApp Division Helper — System Context

    Person(division_member, "Division Member", "23 WhatsApp group members")
    Person(admin, "Administrator", "3 group admins")

    System(wdh, "WhatsApp Division Helper", "24/7 task/report management bot")

    System_Ext(whatsapp, "WhatsApp", "Meta messaging platform")
    System_Ext(deepseek, "DeepSeek API", "LLM for classification and extraction")
    System_Ext(google_sheets, "Google Sheets", "Reporting dashboard")

    Rel(division_member, wdh, "submits reports, asks queries")
    Rel(admin, wdh, "manages tasks, approves actions")
    Rel(wdh, whatsapp, "sends/receives messages", "Baileys WebSocket")
    Rel(wdh, deepseek, "classifies messages, extracts data", "HTTPS REST")
    Rel(wdh, google_sheets, "exports sanitized reports", "Google Sheets API")
```

---

## 2. Container Diagram

```mermaid
C4Container
    title WhatsApp Division Helper — Containers

    Container_Boundary(core_ai, "Core AI (host)") {
        Container(wdh_app, "division-report-assistant", "Node.js + Fastify", "Message ingestion, task management, scheduling, API")
        ContainerDb(postgres, "PostgreSQL", "PostgreSQL 17", "whatsapp_division database")
        Container(litellm, "LiteLLM Gateway", "Python", "Model routing at 127.0.0.1:4000")
    }

    System_Ext(whatsapp, "WhatsApp", "Meta messaging platform")
    System_Ext(deepseek, "DeepSeek API", "LLM provider")
    System_Ext(google_sheets, "Google Sheets API", "Reporting dashboard")

    Rel(wdh_app, whatsapp, "Baileys WebSocket", "wss://web.whatsapp.com")
    Rel(wdh_app, litellm, "LLM requests", "http://127.0.0.1:4000")
    Rel(litellm, deepseek, "Proxied LLM calls", "HTTPS")
    Rel(wdh_app, postgres, "Read/write", "postgresql://")
    Rel(wdh_app, google_sheets, "Export/sync", "HTTPS")
```

**Key decision:** LiteLLM is used as the LLM gateway (consistent with all other AI services in the repo). DeepSeek V4 Flash is added as a new model alias in the LiteLLM config rather than calling the DeepSeek API directly.

---

## 3. Module Boundaries

```text
src/
├── app/                    # Fastify app bootstrap, plugin registration
├── config/                 # Environment, secrets, typed config (Zod-validated)
├── whatsapp/               # Baileys adapter interface + implementation
├── messages/               # Ingestion, deduplication, candidate context
├── members/                # Member service, identity resolution
├── attendance/             # Leave/sick/izin status management
├── projects/               # Project CRUD, confirmation workflow
├── tasks/                  # Task service, state machine, assignments
├── reports/                # Daily report parsing, storage, revisions
├── obstacles/              # Obstacle tracking and resolution
├── reminders/              # Scheduled message generation
├── summaries/              # Morning summary, weekly wrap-up
├── sheets/                 # Google Sheets sync adapter
├── llm/                    # DeepSeek client, redaction, Zod schemas, cost tracking
├── jobs/                   # pg-boss job definitions and handlers
├── audit/                  # Audit event logging
├── health/                 # /healthz and /readyz endpoints
└── shared/                 # Types, errors, time helpers (Asia/Jakarta), logging
```

### Module Dependency Rules

1. `llm/` never imports from `tasks/`, `reports/`, or `members/` — it receives pre-formatted context.
2. `tasks/`, `reports/`, `members/` never import from `llm/` — they consume LLM output as validated data.
3. `whatsapp/` is an adapter — the rest of the app depends on the interface, not the Baileys implementation.
4. `jobs/` depends on `tasks/`, `reports/`, `members/`, `sheets/` — it orchestrates scheduled work.
5. `shared/` has no upward dependencies.

---

## 4. Data Flow — Message Processing

```mermaid
flowchart TD
    A[Baileys receives message] --> B{Deduplication check}
    B -->|duplicate| C[Log and discard]
    B -->|new| D{Deterministic pre-filter}
    D -->|sticker/reaction/noise| E[Store as candidate context, no LLM]
    D -->|report/mention/command| F[Redact phone numbers and JIDs]
    F --> G[Send to LLM via LiteLLM]
    G --> H{Zod validation}
    H -->|invalid| I[Retry with repair prompt, bounded]
    H -->|valid| J{Permission check}
    J -->|unauthorized| K[Notify sender]
    J -->|authorized| L[Execute deterministic state change in PostgreSQL]
    L --> M[Generate audit event]
    L --> N[Send WhatsApp acknowledgment]
    L --> O[Enqueue follow-up jobs if needed]
```

---

## 5. Trust Boundaries

```mermaid
flowchart LR
    subgraph trusted["Trusted Zone"]
        tasks[Task Service]
        members[Member Service]
        reports[Report Service]
        permissions[Permission Engine]
        scheduler[pg-boss Scheduler]
    end

    subgraph semi_trusted["Semi-Trusted Zone"]
        llm_client[LLM Client]
        redaction[Redaction Layer]
        zod_validate[Zod Validator]
    end

    subgraph external["External Zone"]
        wa[WhatsApp / Baileys]
        deepseek_api[DeepSeek API]
        sheets_api[Google Sheets API]
    end

    wa -->|raw message| redaction
    redaction -->|sanitized text| llm_client
    llm_client -->|structured output| zod_validate
    zod_validate -->|validated data| tasks
    tasks -->|authorized query| reports
    tasks -->|authorized query| members
    tasks -->|authorized mutation| scheduler
    scheduler -->|response| wa
    scheduler -->|export| sheets_api
```

**The LLM never directly mutates state.** All mutations go through deterministic service code after Zod validation.

---

## 6. LLM Call Flow

```mermaid
sequenceDiagram
    participant W as WhatsApp
    participant M as Message Handler
    participant R as Redaction Layer
    participant L as LiteLLM/DeepSeek
    participant V as Zod Validator
    participant T as Task Service

    W->>M: Raw message
    M->>R: Message text + sender JID
    R->>R: Replace phone numbers, JIDs with internal IDs
    R->>L: Sanitized text + classification prompt
    L-->>R: Structured JSON response
    R->>V: Validate against schema
    alt Invalid JSON
        V-->>R: Validation error
        R->>L: Repair prompt (bounded retries)
        L-->>R: Corrected JSON
        V->>V: Re-validate
    end
    V->>T: Validated classification + extraction
    T->>T: Deterministic state mutation
    T->>W: Acknowledgment / clarification request
```

---

## 7. WhatsApp Reconnect Flow

```mermaid
flowchart TD
    A[Connection lost] --> B[Log outage interval]
    B --> C[Attempt reconnect with backoff]
    C -->|success| D[Announce outage interval in group]
    D --> E[Request resubmission of important messages]
    C -->|failure after max retries| F[Alert administrators via Telegram]
    F --> G[Manual intervention required]
    G --> C
```

**No automatic backlog processing on reconnect.** The user must manually trigger reprocessing of specific messages.

---

## 8. Google Sheets Sync Flow

```mermaid
flowchart TD
    A[Scheduled job triggers] --> B[Query PostgreSQL for new/changed records]
    B --> C[Apply data minimization: no JIDs, no phone numbers]
    C --> D[Write to append-only tabs]
    D --> E[For admin-editable tabs: check for conflicts]
    E -->|conflict| F[Log conflict, notify admin]
    E -->|clean| G[Apply admin edits to PostgreSQL]
    G --> H[Create audit event]
```

Sync is **one-way by default** (PostgreSQL → Sheets). Limited two-way edits only on specific tabs (TASKS: title, project, status, deadline, assignees, notes, active).

---

## 9. Failure Mode Matrix

| Failure | Impact | Mitigation |
|---------|--------|------------|
| WhatsApp disconnect | No messages received/sent | Reconnect with backoff, alert admin, no backlog processing |
| DeepSeek API down | Cannot classify messages | Deterministic fallback for simple queries, queue for later, alert admin |
| DeepSeek invalid response | Cannot extract data | Bounded retry with repair prompt, then ask user for clarification |
| PostgreSQL down | Cannot persist state | Reject all mutations, queue WhatsApp send attempts, alert admin |
| Google Sheets API down | Dashboard stale | Continue WhatsApp processing unaffected, retry sync later |
| pg-boss failure | Scheduled outputs miss | Restart recovery, missed jobs logged, manual catch-up |
| Baileys session invalid | WhatsApp access lost | Re-pair required, documented recovery procedure |
| LLM budget exhausted | No more LLM calls | Hard-limit degradation mode, deterministic processing only |
| Container OOM | Service crash | Docker restart policy, resource limits configured |

---

## 10. Deployment Resources (Core AI)

| Resource | Allocation |
|----------|-----------|
| Container | `division-report-assistant` |
| Image | Custom Node.js 22 LTS (Alpine or Slim) |
| RAM | 512 MB limit, 256 MB reservation |
| CPU | 0.5 limit, 0.25 reservation |
| PIDs | 256 |
| Volume | `/opt/app/data/division-report-assistant/` (sessions, state) |
| Secrets | `/opt/app/secrets/division-report-assistant/` (env_file) |
| Port | Not published to host (internal only) |
| Network | `monitoring` (for health checks) + internal |
| PostgreSQL | Shared instance, database `whatsapp_division` |
| Health | `/healthz` (liveness), `/readyz` (readiness) |

---

## 11. Port Allocation

Following the existing convention:

| Service | Port | Binding |
|---------|------|---------|
| LiteLLM | 4000 | 127.0.0.1 |
| Context MCP | 8010 | 127.0.0.1 |
| Ops MCP | 8011 | 127.0.0.1 |
| Community Ops MCP | 8012 | 127.0.0.1 |
| Search MCP | 8013 | 127.0.0.1 |
| Smoke | 8080 | 127.0.0.1 |
| **WDH (proposed)** | **8020** | **127.0.0.1** |

---

## 12. Backup Integration

- Add PostgreSQL `pg_dump` for `whatsapp_division` to the existing Restic backup flow;
- include session state volume in backup scope;
- exclude WhatsApp auth secrets from backup (regenerable via re-pair);
- test restore procedure alongside existing `postgres-restore-drill`.
