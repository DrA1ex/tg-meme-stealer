# Architecture

## Runtime Modes

`index.js` loads config, configures logging, then dispatches by command:

- `node index.js session`: starts QR login and writes the mtcute user session.
- `node index.js setup`: creates the app, launches the admin bot, and registers setup mode commands without starting the scheduler.
- `node index.js daemon`: creates the app, launches the admin bot, and starts the scheduler.

`npm start`, `npm run session`, and `npm run setup` are thin wrappers around those modes.

## App Composition

`src/runtime/app.js` is the dependency graph. `createApp(config)` initializes:

- `PostRepository` for SQLite tables and queries.
- mtcute user client from `src/telegram/userClient.js`.
- `TelegramScanner` for source history scanning and backfill.
- One shared `JobGate` for sync, backfill, retention, and publication worker coordination.
- `SyncWorker` and `RetentionWorker`.
- `MediaDownloader` for reloading source messages and downloading media before publishing.
- `SetupAssistant` for admin setup sessions and diagnostics.
- `SelectionPublisher` for Telegraf commands and publication processing.

Shutdown stops bot polling, stops scheduler timers in daemon mode, destroys the user client, and closes SQLite.

## Scheduler

`src/runtime/scheduler.js` schedules four recurring concerns in daemon mode:

- Sync runs every `sync.intervalHours`.
- Retention runs after `sync.retentionInitialDelayMinutes` and then every `sync.retentionIntervalHours`.
- Publication timers are created from enabled entries in `publish.template`.
- The publication worker wakes every `publish.workerIntervalMinutes`.

On startup, `Scheduler.start()` schedules timers immediately. If `sync.runOnStart` is enabled, it runs startup sync, then plans missed publications, then wakes the publication worker. If startup sync is disabled, it still plans missed publications and wakes the worker.

The scheduler uses local schedule calculations from the configured `schedule.timezone`. It supports daily, weekly, and monthly publication schedules. Very long timeouts are chunked because Node timers have a maximum delay.

## Job Serialization

`src/runtime/jobGate.js` is an in-memory queue and duplicate guard:

- `run(key, fn)` queues different keys if another job is running.
- Duplicate running or queued keys are skipped with `reason: duplicate_job`.
- `runIfIdle(key, fn)` skips when any job is running or queued.
- `queueIfRunning` allows exactly one follow-up for a running duplicate key, used by the publication worker.
- Nested same-key calls run inline; nested different-key calls throw a deadlock error.

This means scheduled jobs can queue behind each other, while admin sync/backfill requests are more conservative and report busy instead of silently waiting.

## Admin Bot Boundary

`SelectionPublisher` configures the Telegraf bot in `src/telegram/publisher.js`. It rejects commands unless they come from `telegram.adminId` in a private chat. The core admin commands are `/stats`, `/jobs`, `/publications`, `/publication`, `/sync`, `/backfill`, `/publish`, and `/setup`.

The setup assistant is registered onto the same bot, so setup mode and daemon mode share the command surface but differ in whether scheduler jobs are running.

