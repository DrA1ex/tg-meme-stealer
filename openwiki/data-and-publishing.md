# Data And Publishing

## Message Parsing

`src/core/postParser.js` turns Telegram messages into stored posts. It:

- Skips unreadable messages.
- Applies `parsing.filters`.
- Extracts likes, dislikes, and author from configured rule arrays.
- Falls back to inline button reaction parsing and simple text author extraction when configured extractors do not produce values.
- Supports text, photo, video, and album-style grouped media references.
- Provides debug traces for setup diagnostics.

Rule paths can traverse message and sender objects, including arrays. Transforms cover common parser needs such as count parsing, trimming, usernames, booleans, content checks, media checks, and reaction counts.

## Scanning And Backfill

`src/telegram/scanner.js` owns source history reads through mtcute:

- `sync()` decides whether the database is empty. Empty databases scan `sync.initialScanDays`; later syncs refresh `sync.refreshRecentDays`.
- `backfill(days)` scans a requested historical window, adds missing old posts, and updates existing posts only inside the recent refresh window.
- Recent deleted source messages are removed from `posts`.
- Old rows are pruned by `cleanupOldPosts()` through the retention worker.

Telegram history and media requests pass through `TelegramThrottle` and retry wrappers from `src/telegram/retry.js`.

## SQLite Schema

`src/database/postRepository.js` creates three tables:

- `posts`: source chat/message identity, author, text, likes, dislikes, JSON data, message date, collected time, and update time.
- `publications`: durable publication jobs with key, selection key, title, period, status, timestamps, last error, and JSON snapshot data.
- `publication_posts`: rows sent or planned for a publication, including position, reaction counts, bot message id, and send timestamp.

Important behavior:

- `posts` are upserted by `(chat_id, message_id)`.
- Active publication keys are unique while status is `created`, `running`, or `published`.
- `dry_run`, `failed`, and `cancelled` publication rows do not block a later real publication.
- Publication post rows let the worker resume after partial Telegram send failure.

## Selection Logic

`src/core/selection.js` builds selection specs from `publish.template`. Each spec includes:

- Source chat id.
- Source key and template key, exposed as `source.templateKey`.
- Rolling window `[scheduledAt - windowHours, scheduledAt)`.
- Post count limits `{ min, target, max }`.
- Reaction strategy and thresholds.
- SQL snippets compiled from source expressions and reaction strategy.

`src/core/sourceExpression.js` compiles a deliberately small SQL-like language for `publish.sources[].where`. It only permits `likes`, `dislikes`, numeric literals, boolean/comparison/arithmetic operators, and `abs`, `min`, `max`.

`PostRepository.getSelectionPosts()` applies the source filter and reaction scoring inside SQLite. It tries to publish around `posts.target`, expands up to `posts.max` for posts above `reactions.includeAbove`, and backfills to `posts.min` when too few posts pass `reactions.min`.

## Publication Requests

`SelectionPublisher` does not send immediately from scheduler callbacks. It first creates a durable publication request:

1. Build one or more selection specs from requested keys.
2. Skip disabled templates unless forced.
3. Apply effective `firstSendAt`, using the later of global and template-level gates.
4. Skip when an active/published publication with the same canonical key already exists.
5. Snapshot selected posts into the publication row data.
6. Wake or queue the publication worker.

The canonical publication key includes source, template key, and a local timestamp bucket. Forced publishes use a random key prefix so they can intentionally duplicate an already published selection.

## Sending Rich Posts

`src/telegram/richPost.js` sends a selection header, then each selected post:

- Text-only posts become bot messages.
- Media posts reload source messages, download media into `sync.mediaDir`, and send the first media item with the caption.
- Extra album media are sent individually.
- Temporary media files are cleaned after send attempts.

If a send fails after some posts were recorded, the next worker run resumes from the first unsent position rather than starting over.

