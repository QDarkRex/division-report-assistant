# WDH audit advice handoff

Date: 2026-09-02 (WIB)  
Audience: agent/session lain yang melanjutkan WhatsApp Division Helper (WDH)  
Audited source: `origin/main` commit `da0459f`

## Purpose and boundary

Dokumen ini berisi temuan dan saran audit saja. Jangan menganggap poin di bawah
sudah diimplementasikan. Jangan menimpa perubahan lokal pada checkout utama;
gunakan branch atau worktree bersih dari `origin/main`.

## Evidence that already passed

- Clean install, typecheck, and production build passed.
- GitHub Actions WDH job passed on Linux/Node 22 with 423 tests, migration check,
  build, container image build, and non-root runtime check.
- The repository-level workflow was red because a separate, unrelated job in the
  monorepo was missing a Python dependency; that is not evidence that the WDH
  job failed.

## Findings in recommended priority order

### 1. Upgrade the high-severity dependency first

`npm audit` reported five findings: four moderate and one high. The high finding
affects `drizzle-orm` versions below `0.45.2` (SQL identifier escaping). WDH
currently allows `^0.44.6`.

Recommendation:

1. Upgrade `drizzle-orm` to a non-vulnerable compatible release.
2. Refresh the lockfile with the project's package manager.
3. Run the complete WDH test, typecheck, build, migration check, and image check.
4. Confirm `npm audit --audit-level=high` exits successfully.

The current source search did not find dynamic identifier helpers such as
`sql.identifier` or `sql.raw`, so direct exposure may be lower, but this is not a
reason to leave the dependency unfixed.

### 2. Do not rerun the August bootstrap script as-is

`src/scripts/bootstrap-projects-20260831.ts` is dangerous as a repeatable
operator command:

- it selects every task whose status is not `cancelled` and cancels them;
- it then creates 12 tasks without a deduplication/idempotency guard.

Rerunning it with `--apply` can cancel legitimate current work and duplicate the
bootstrap tasks.

Recommendation: archive the script as a one-time migration or change it to use
an explicit allowlist of legacy task IDs plus a durable "already applied" guard.
Do not run it in production before that change is reviewed.

### 3. Replace per-tab delay with request-aware Google Sheets pacing

The current `INTER_TAB_DELAY_MS=400` applies between tabs, while one date tab can
generate roughly ten Sheets API requests (tab discovery/creation, reset,
clear/update, and several formatting calls). A 400 ms tab delay therefore does
not enforce the code's own assumed 60-requests-per-minute budget.

Recommendation: centralize pacing at the individual Sheets request boundary or
batch compatible operations. Honor `Retry-After`/quota responses and test a
multi-tab sync under a realistic quota.

### 4. Treat the Windows Node 24 crash as unresolved, not proven bad RAM

On this Windows host, the full suite reached 422/423 and then V8 crashed in
`UnregisterWasmAllocation`. The isolated final test passed twice, while Linux
Node 22 CI passed all 423 tests. This evidence does not prove defective RAM.

Recommendation: reproduce with the supported Node 22 runtime, run repeated
suite/stress loops, and compare Node 24 only as a separate experiment. Document
hardware failure only if independent memory diagnostics actually fail.

### 5. Repair documentation drift

The README contains duplicated sections and stale test counts (394 versus the
current 423), including repeated material around Notulensi, accuracy, tags,
cost dashboard, and flakiness.

Recommendation: consolidate duplicates and make generated/CI evidence the source
for test counts.

## Separate branch warning

The branch `security/mcp-auth-and-observability` contains useful ideas but was
not merge-ready during this audit:

- live MCP ports 8444-8447 still accepted unauthenticated `tools/list`;
- active Context/Ops clients had not been migrated to bearer headers;
- three proposed status probes were not on the monitor network and would create
  false alerts if deployed directly;
- monorepo CI still had that unrelated dependency failure.

Do not deploy that branch wholesale. Split it into independently accepted
changes with client migration and live network validation.

## Suggested execution order

1. Dependency upgrade and high-severity audit gate.
2. Make the one-off bootstrap impossible to rerun destructively.
3. Correct Sheets request pacing and add quota-focused tests.
4. Clean README drift.
5. Repair the unrelated CI dependency in the monorepo this was extracted from.
6. Run WDH validation on Linux/Node 22, then perform a controlled deployment and
   verify live database/task counts before and after.

## Definition of done

- No high-severity npm audit failure.
- The bootstrap cannot cancel unrelated tasks or duplicate its own output.
- Sheets sync respects a measurable request budget under multi-tab load.
- All WDH tests, typecheck, build, migration check, and image checks pass.
- Documentation matches current commands and test counts.
- A live deployment is verified without unexpectedly changing existing tasks.
