# Data and publishing

## From Telegram message to post

`src/telegram/scanner.js` reads source history through the mtcute user client. `src/core/postParser.js` decides eligibility using `parsing.filters` and extracts configured author, likes, dislikes, text, media, and diagnostic traces. Rules traverse message/sender paths, including arrays; parser fallbacks cover inline-button reactions and basic author extraction. Text, photos, videos, and grouped albums are supported.

`sync()` uses `sync.initialScanDays` when the source has no stored posts, then refreshes only `sync.refreshRecentDays`. `backfill(days)` adds missing older rows but refreshes existing rows only in the recent window. Pagination guards repeated cursors and excessive pages. A scan that is incomplete or non-authoritative never deletes local rows.

Recent deleted-post reconciliation compares source IDs with stored IDs. It refuses deletion when the scan is incomplete or the missing ratio exceeds `sync.maxMissingRatio`; `/sync --force` bypasses only the ratio guard. Separate retention later deletes source posts older than `sync.retentionDays`.

## SQLite model

`PostRepository` opens `better-sqlite3` through `sqliteDatabase.js`, enables WAL, foreign keys, and a five-second busy timeout, then applies `migrations.js` under `BEGIN IMMEDIATE`.

- `posts`, keyed by `(chat_id, message_id)`, stores parsed source state. Upsert preserves original collection time while refreshing parsed fields.
- `publications` stores durable selection snapshots, request key, lifecycle state, lease metadata, retry/progress metadata, and errors.
- `publication_posts` stores each selected item's rank scores, send state, attempt/error data, and target message ID.


Publication history survives source retention because it is snapshotted separately; detailed views that join live posts may no longer show original text/author after retention.

## Selection configuration

`src/core/selection.js` turns enabled `publish.template` entries into rolling-window specs. The public key is `source.templateKey`; aliases may select a template key, source key, or `source.*`. A window is `[scheduledAt - offsetHours - windowHours, scheduledAt - offsetHours)`. Templates define `posts.min/target/max`, reaction strategy/minimum/include-above, title template, source, and schedule.

Source predicates in `publish.sources[].where` are compiled by `sourceExpression.js`. The allowlist contains `likes`, `dislikes`, numeric values, operators, and `abs`, `min`, `max`; unsupported syntax is rejected before SQL is built. Treat expressions as validated configuration code, not arbitrary SQL.

## Durable publication lifecycle

Planning and sending are separate:

1. Scheduler or `/publish` builds a selection and snapshots it into a `created` SQLite request.
2. The publication worker claims an eligible request under a SQLite lease.
3. It persists header/post `sending` state before external calls, sends rich content, and records per-item outcomes.
4. It finishes as `published`, `dry_run`, `failed`, `cancelled`, or `uncertain`.

Canonical keys use source, template, and local scheduled-time bucket. A partial unique index blocks duplicate active/published keys; forced manual requests intentionally use a distinct key. Lease renewal occurs about every third of `publish.workerLeaseMs`; lease loss aborts new side effects.

If shutdown/network ambiguity leaves a header or post as `sending`, recovery marks the request `uncertain` and does not auto-resend. Inspect the destination channel and `/publication <id>` before a manual forced replacement. Transient failures defer retry; permanent/unknown-exhausted outcomes update state, and stale requests are failed by configured TTL logic.

## Delivery and media

`richPost.js` sends a selection header, then text or source media. `media.js` records when portable mtcute file IDs were captured, uses only fresh references directly, and proactively refreshes legacy or stale references through exact source history before download. Unexpected early `FILE_REFERENCE_EXPIRED` responses are refreshed once and do not count as publication failures. Downloads use transient files under `sync.mediaDir`; albums send first item with caption and remaining items separately. Cleanup runs after attempts. Bot API limiter/retry policy wrap sends, so delivery changes must retain lease checks and indeterminate-outcome handling.


Test this domain through `db.test.js`, `selection.test.js`, `sourceExpression.test.js`, `scanner.test.js`, `publicationReliability.test.js`, `publisherLifecycle.test.js`, and media tests. See [configuration-and-operations.md](configuration-and-operations.md) for operator recovery.
