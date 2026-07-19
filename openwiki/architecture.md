# Architecture

`index.js` loads validated configuration, configures logging, and dispatches `session`, `setup`, or default `daemon` mode. Session mode creates the QR-authenticated mtcute user session. Setup mode creates the complete app and launches the admin bot without timers. Daemon mode launches that bot and starts the scheduler.

## Runtime composition

`createApp()` in `src/runtime/app.js` constructs the dependency graph in this order:

1. `PostRepository` initializes SQLite and migrations.
2. `startUserClient()` creates the MTProto reader for the source chat.
3. Optional Redis rate-limit store plus MTProto and Bot API limiters are created.
4. `TelegramScanner`, a shared `JobGate`, `SyncWorker`, `RetentionWorker`, and `MediaDownloader` are wired.
5. `SetupAssistant` and `SelectionPublisher` share the bot-facing configuration and limits.
6. Sync notifications route through the publisher to the private admin.

App construction cleans up already-created resources if a later dependency fails to initialize.

## Scheduling and local concurrency

`Scheduler` (`src/runtime/scheduler.js`) has independent schedules for periodic sync, retention, the publication worker, and each enabled daily/weekly/monthly template. It uses `schedule.timezone`, passes the *intended scheduled time* to publication planning, and chunks long delays to avoid Node timer limits. On startup it performs configured startup sync, then plans missed slots within request TTL and wakes the worker.

`JobGate` serializes local work: `run()` queues different keys and skips duplicate keys; `runIfIdle()` rejects admin sync/backfill while any work exists; `queueIfRunning()` permits one follow-up worker pass. Nested same-key work executes inline; nested different-key work throws `NESTED_DEADLOCK`. It prevents overlap only inside one process. Publication uniqueness and leases in SQLite provide cross-process coordination for shared databases.

## Bot lifecycle and shutdown

Before polling, `BotLifecycle` calls `getMe()` and acquires `data/bot-polling.lock`. A live lock owner produces `BOT_POLLING_LOCKED`; stale locks are removed. This is a filesystem/PID lock, not a distributed lock. If polling ends unexpectedly, `index.js` begins shutdown.

`app.shutdown()` aborts new work, closes the gate and rate limiters, stops bot polling, waits for gate drain until a deadline, and then closes the user client, Redis store, and database. The deadline is `shutdown.timeoutMs`; resource closure may cut off a remaining Telegram operation after it expires. Preserve abort-signal propagation in long-running code.


## Reliability boundaries

- Sync failure after retries pauses publication *in memory* until the next successful sync; restart clears that pause.
- Worker side effects are protected by SQLite leases, but selection/sync/retention still rely on local `JobGate`.
- An indeterminate Telegram send becomes `uncertain`, deliberately favoring duplicate avoidance over automatic completion.
- Rate-limit coordination via Redis is optional; unavailable Redis uses conservative local fallback.

Explaining recent history: `5ba007f` introduced bounded graceful shutdown, `89a92b6` expanded recovery/polling/lease safety, and `7b66dfe` replaced the vulnerable SQLite dependency chain with the current `better-sqlite3` adapter.


See [data-and-publishing.md](data-and-publishing.md) for the durable state model and [testing.md](testing.md) for change checks.

## Sync write path

The scanner reads source history sequentially, verifies native reaction summaries with `getMessageReactions`, assembles cross-page albums, and writes each parsed page in one SQLite transaction. Deleted-post reconciliation also uses bounded batch deletes.

See [Sync and reaction verification](sync-and-reactions.md).
