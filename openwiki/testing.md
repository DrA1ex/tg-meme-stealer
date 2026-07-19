# Testing and verification

## Commands and CI baseline

The repository uses Node’s built-in test runner:

```bash
npm test
# equivalent script: node --test
```

CI (`.github/workflows/test.yml`) runs `npm ci` and `npm test` on Ubuntu/Node 20. It starts Redis 7 and exposes `TEST_REDIS_URL`, so both the low-level shared store tests and the end-to-end synchronization/Redis tests run instead of being skipped for lack of a service.

After a successful **push** test workflow on `main`, `.github/workflows/trigger-deploy.yml` dispatches that workflow’s tested SHA to the private deployment repository. Preserve this test-before-dispatch relationship when editing workflow names or triggers.

## High-signal test map

| Domain | Primary tests |
| --- | --- |
| Config loading, merge/migration, semantic validation | `test/config.test.js`, `test/setupConfig.test.js` |
| App construction, graceful shutdown, job serialization | `test/app.test.js`, `test/jobGate.test.js` |
| Scheduler/catch-up/timezones/worker wakeup | `test/scheduler.test.js` |
| Source scanning, backfill, reconciliation, albums | `test/scanner.test.js`, `test/syncWorker.test.js`, `test/historyAssembler.test.js`, `test/retentionWorker.test.js`, `test/redisSyncIntegration.test.js` |
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

# Rate limiter changes without a local Redis server
npm test -- test/throttle.test.js test/botRateLimiter.test.js test/redisRateLimitStore.test.js

# Real Redis synchronization and shared-rate-limit integration
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

## What to test beyond the happy path

- **SQLite changes:** include a migration/upgrade fixture and test state reads/writes, not only new schema creation. The migration suite verifies version advancement, delivery-state upgrades, durable pending-error storage, and recursive removal of legacy media file references from posts and publication snapshots.
- **Publication changes:** exercise duplicate request prevention, lease loss, retries, cancellation, uncertain `sending` behavior, and one shared bounded source-history prefetch per attempt. Do not make tests assert automatic resend after a possible side effect.
- **Scanner changes:** test authoritative versus incomplete scans and deletion-safety threshold behavior. For shared throttling changes, also cover the full `SyncWorker → TelegramScanner → TelegramThrottle → Redis` path with separate clients.
- **Scheduler changes:** test startup order, missed-run boundaries, first-send gates, timezone/local-time calculations, and timer rescheduling after errors.
- **Setup changes:** test both callback UI and text-command routes when they expose the same capability. Media preview must reuse the freshly scanned in-memory Telegram messages rather than persist or re-resolve media references.
- **Shutdown/concurrency changes:** confirm queued work is rejected/cancelled and active operations honor signals/deadlines.

## Pre-handoff checks

1. Run focused tests for the owned domain.
2. Run `npm test` if touching shared config, runtime composition, database, parser, scanner, scheduler, publisher, or common retry/rate-limit behavior.
3. Inspect `git diff` and `git status`; documentation/init work must not alter source code, secrets, or user-authored `openwiki/INSTRUCTIONS.md`.
4. For workflow edits, verify the CI workflow name and workflow-run branch/conclusion conditions rather than relying on static YAML formatting alone.

## Reaction verification coverage

The scanner tests keep `getMessageReactions` authoritative while comparing it with summaries embedded in history. They cover matching summaries, mismatches, empty authoritative results, exclusion of messages outside the refresh window, and page-level database batching.

See [Sync and reaction verification](sync-and-reactions.md) for the runtime contract.
