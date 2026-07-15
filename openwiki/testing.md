# Testing and verification

## Commands and CI baseline

The repository uses Node’s built-in test runner:

```bash
npm test
# equivalent script: node --test
```

CI (`.github/workflows/test.yml`) runs `npm ci` and `npm test` on Ubuntu/Node 20. It starts Redis 7 and exposes `TEST_REDIS_URL`, so shared rate-limit/store tests run in CI rather than being skipped for lack of a service.

After a successful **push** test workflow on `main`, `.github/workflows/trigger-deploy.yml` dispatches that workflow’s tested SHA to the private deployment repository. Preserve this test-before-dispatch relationship when editing workflow names or triggers.

## High-signal test map

| Domain | Primary tests |
| --- | --- |
| Config loading, merge/migration, semantic validation | `test/config.test.js`, `test/setupConfig.test.js` |
| App construction, graceful shutdown, job serialization | `test/app.test.js`, `test/jobGate.test.js` |
| Scheduler/catch-up/timezones/worker wakeup | `test/scheduler.test.js` |
| Source scanning, backfill, reconciliation, albums | `test/scanner.test.js`, `test/syncWorker.test.js`, `test/historyAssembler.test.js`, `test/retentionWorker.test.js` |
| Parsing and source-expression grammar | `test/postParser.test.js`, `test/sourceExpression.test.js`, `test/selection.test.js` |
| SQLite migrations, selection SQL, state transitions | `test/db.test.js` |
| Publishing, leases, recovery, delivery uncertainty | `test/publisher.test.js`, `test/publicationReliability.test.js`, `test/publicationLease.test.js`, `test/publisherLifecycle.test.js` |
| Rich media and error/retry classification | `test/media.test.js`, `test/richPost.test.js`, `test/retry.test.js`, `test/errorPolicy.test.js` |
| Local/shared throttling | `test/throttle.test.js`, `test/botRateLimiter.test.js`, `test/redisRateLimitStore.test.js`, `test/rateLimitUtils.test.js` |
| Setup UI, diagnostics, schedule/publish authoring | `test/setupAssistant.test.js`, `test/setupFormattingAndKeyboards.test.js`, `test/setupParserSuggestions.test.js`, `test/setupPublishSourcesSchedule.test.js`, `test/setupTechnicalDiagnostics.test.js`, `test/setupTestsRegressions.test.js` |

## Focused verification recipes

Use the smallest relevant set while iterating, then run the full suite for cross-cutting changes.

```bash
# Parser rules, paths, diagnostics
npm test -- test/postParser.test.js test/setupParserSuggestions.test.js test/setupTechnicalDiagnostics.test.js

# Config/defaults/draft persistence
npm test -- test/config.test.js test/setupConfig.test.js

# SQLite schema, ranking, publication state
npm test -- test/db.test.js test/selection.test.js test/publicationReliability.test.js

# Scheduler and publication scheduling/recovery
npm test -- test/scheduler.test.js test/publisher.test.js test/publisherLifecycle.test.js

# Scan/reconciliation/retry safety
npm test -- test/scanner.test.js test/syncWorker.test.js test/historyAssembler.test.js

# Rate limiter changes
npm test -- test/throttle.test.js test/botRateLimiter.test.js test/redisRateLimitStore.test.js
```

## What to test beyond the happy path

- **SQLite changes:** include a migration/upgrade fixture and test state reads/writes, not only new schema creation. The current migration suite verifies version advancement and a v1 upgrade.
- **Publication changes:** exercise duplicate request prevention, lease loss, retries, cancellation, and uncertain `sending` behavior. Do not make tests assert automatic resend after a possible side effect.
- **Scanner changes:** test authoritative versus incomplete scans and deletion-safety threshold behavior.
- **Scheduler changes:** test startup order, missed-run boundaries, first-send gates, timezone/local-time calculations, and timer rescheduling after errors.
- **Setup changes:** test both callback UI and text-command routes when they expose the same capability.
- **Shutdown/concurrency changes:** confirm queued work is rejected/cancelled and active operations honor signals/deadlines.

## Pre-handoff checks

1. Run focused tests for the owned domain.
2. Run `npm test` if touching shared config, runtime composition, database, parser, scanner, scheduler, publisher, or common retry/rate-limit behavior.
3. Inspect `git diff` and `git status`; documentation/init work must not alter source code, secrets, or user-authored `openwiki/INSTRUCTIONS.md`.
4. For workflow edits, verify the CI workflow name and workflow-run branch/conclusion conditions rather than relying on static YAML formatting alone.
