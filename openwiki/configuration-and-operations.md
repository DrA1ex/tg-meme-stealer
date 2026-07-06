# Configuration And Operations

## Config Loading

`src/config/index.js` loads `config.default.json`, deep-merges optional `config.json`, then overlays Telegram values from environment variables. The default config is the source of available runtime options.

Environment-backed Telegram fields:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_SOURCE_CHAT_ID`
- `TELEGRAM_ADMIN_ID`
- `TELEGRAM_PUBLISH_CHANNEL_ID`
- `TELEGRAM_BOT_TOKEN`

Do not store secrets in docs. `.env.example` is only a placeholder reference.

## Merge Rules

Most config objects deep-merge. Two publish sections are special:

- `publish.template` arrays are replaced as a whole.
- `publish.sources` merge by `key`.

This lets local config override or clear template schedules intentionally while still allowing source definitions to be extended by key.

## Validation Rules

Config validation rejects:

- Missing required Telegram and database fields.
- Identical source and publish chats.
- Unsupported config keys or wrong primitive types.
- Duplicate publish template keys.
- Invalid source expressions.
- Publish templates with unknown sources, invalid schedules, invalid reaction strategies, bad `firstSendAt`, or invalid `posts.min <= posts.target <= posts.max` ordering.

Enabled schedules must be daily, weekly, or monthly. Monthly schedules use days `1..28`.

## Operational Commands

Run modes:

```bash
npm run session
npm run setup
npm start
```

Admin bot commands:

- `/stats`: database and publication summary from `src/core/stats.js`.
- `/jobs`: active and recent publication job summary.
- `/publications`: recent publication list.
- `/publication <id>`: detailed publication posts.
- `/sync`: refresh recent source history.
- `/backfill [days]`: fill or refresh a larger historical window.
- `/publish <selection...> [--force]`: create and process publication requests.
- `/setup`: open setup assistant.

Only `telegram.adminId` in a private chat can run commands.

## Scheduling And First-Send Gates

Daemon mode uses `schedule.enabled` and `schedule.timezone`. Each enabled `publish.template[]` item may schedule a daily, weekly, or monthly run. `windowHours` controls the selection duration; optional `offsetHours` moves only that selection window back from the run time. For example, `windowHours: 24` and `offsetHours: 168` publish a one-day window from one week before the scheduled run.

`publish.firstSendAt` gates all normal publication scheduling. A template-level `firstSendAt` can also be set; the later timestamp wins. Scheduler catch-up and regular `/publish` respect this gate. `/publish <key> --force` can publish earlier and can include disabled templates when explicitly requested.

The publication worker uses durable requests in SQLite. If a scheduler run, manual run, or retry sees an already active/published canonical publication key, it reports the existing request instead of creating a duplicate.

## Retention And Temporary Files

Retention removes old source posts from `posts` based on `sync.retentionDays`. Publication history is preserved in `publications` and `publication_posts`.

Media downloads are temporary. `MediaDownloader` writes files under `sync.mediaDir`, sends them through the bot API, and deletes them after each rich post attempt.

## Logging

`src/core/logger.js` supports configured levels `DEBUG`, `INFO`, `WARN`, `ERROR`, and `SILENT`, plus color modes `auto`, `always`, and `never`. Runtime logs include command startup fields, scheduler timers, history scan pages, publication request states, worker results, and Telegram errors.
