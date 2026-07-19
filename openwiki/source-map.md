# Source map

Use this page to enter the implementation by concern rather than by file name.

| Concern | Start here | Supporting code / tests |
| --- | --- | --- |
| CLI modes and process lifecycle | `index.js` | `src/runtime/app.js`, `test/app.test.js` |
| Configuration and validation | `src/config/index.js` | `config.default.json`, `.env.example`, `test/config.test.js` |
| Runtime scheduling and local execution | `src/runtime/scheduler.js`, `src/runtime/jobGate.js` | `src/runtime/syncWorker.js`, `src/runtime/retentionWorker.js`, `test/scheduler.test.js`, `test/jobGate.test.js` |
| Database adapter, schema, query/state layer | `src/database/sqliteDatabase.js`, `src/database/migrations.js`, `src/database/postRepository.js` | `test/db.test.js` |
| Parser and post selection | `src/core/postParser.js`, `src/core/selection.js`, `src/core/sourceExpression.js` | `src/core/setupConfig.js`, `test/postParser.test.js`, `test/selection.test.js`, `test/sourceExpression.test.js` |
| Source sync/reconciliation | `src/telegram/scanner.js` | `src/telegram/historyAssembler.js`, `src/runtime/syncWorker.js`, `test/scanner.test.js`, `test/syncWorker.test.js` |
| Publisher, queue, and admin commands | `src/telegram/publisher.js`, `src/telegram/adminCommands.js` | `src/runtime/publishLog.js`, `test/publisher.test.js`, `test/publicationReliability.test.js` |
| Cross-process publication safety | `src/telegram/publicationLease.js`, repository claim/lease methods | `test/publicationLease.test.js`, `test/publisherLifecycle.test.js` |
| Rich media | `src/telegram/media.js`, `src/telegram/richPost.js` | `test/media.test.js`, `test/richPost.test.js` |
| Bot startup and polling exclusivity | `src/telegram/botLifecycle.js`, `src/telegram/botPollingLock.js` | `test/botPollingLock.test.js` |
| Telegram failure policy and pacing | `src/telegram/errorPolicy.js`, `src/telegram/retry.js`, `src/telegram/throttle.js`, `src/telegram/botRateLimiter.js` | `src/telegram/redisRateLimitStore.js`, related rate/retry tests |
| Setup assistant | `src/telegram/setupAssistant.js`, `src/telegram/setupAssistant/session.js` | `src/telegram/setupAssistant/`, `src/telegram/setup/`, setup test family |
| User-session setup | `src/telegram/userClient.js` | `README.md` launch flow |
| Operations/instance cloning | `README.md`, `scripts/README.md`, `scripts/clone.sh` | `ecosystem.example.json`, GitHub workflows |

## Extension routes

- Add a parser transform or selection behavior only after locating its parser/compiler validation and setup diagnostics exposure.
- Add a publication lifecycle state only with repository migration, recovery/read models, admin rendering, and tests for interruption/duplicate effects.
- Add a new scheduler behavior through `Scheduler` and `JobGate`; preserve planned-time semantics.
- Add bot commands through the admin authorization boundary—do not register a privileged command outside `adminCommands.js` / publisher composition.
- Add configuration only with default, schema validation, setup persistence/formatting if user-editable, and targeted tests.

See [architecture.md](architecture.md) for boundary rationale and [testing.md](testing.md) for the test matrix.

## Sync and reaction refresh

- `src/telegram/scanner.js` — history pagination, reaction enrichment and verification, parsing, reconciliation, preview scans, and backfill scanning.
- `src/database/postRepository.js` — transactional `upsertPosts()` and bounded `deletePosts()` used by sync.
- `openwiki/sync-and-reactions.md` — request flow, verification counters, and failure behavior.
