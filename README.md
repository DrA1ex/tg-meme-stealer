# tg-meme-stealer

Telegram rankings bot for communities where a regular bot cannot be added to the source group.

`tg-memes` logs in as a regular Telegram user with [mtcute](https://mtcute.dev), scans posts from a source chat, stores post stats in SQLite, and publishes ranked selections to a target channel through a Telegram bot powered by Telegraf.

It supports text posts, photos, videos, albums, configurable parsing rules, QR login, scheduled publishing, and an admin-only setup mode for tuning filters before the first real sync.

## Features

- Scans a Telegram group or channel with a user account.
- Supports QR login for the userbot session.
- Stores posts in SQLite with `chat_id`, `message_id`, extracted `author`, `text`, `likes`, `dislikes`, and structured `data`.
- Handles text posts, photos, videos, and albums.
- Refreshes recent posts because like/dislike counters can change.
- Removes recently deleted source posts from the local database.
- Publishes configurable top selections to a target Telegram channel.
- Publishes configurable controversial selections from rolling time windows.
- Keeps a publication log in SQLite.
- Provides admin-only bot commands for stats and parser setup.
- Uses templates for published captions and admin stats.

## Requirements

- Node.js 20 or newer.
- A Telegram API ID and API hash from <https://my.telegram.org>.
- A regular Telegram account that can read the source group or channel.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- The bot must be able to post to the target channel.

## Installation

```bash
git clone https://github.com/DrA1ex/tg-meme-stealer
cd tg-meme-stealer
```

The rest of the setup is covered in the launch flow below.

Create `.env` from `.env.example` and fill in:

```dotenv
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SOURCE_CHAT_ID=-1001234567890
TELEGRAM_ADMIN_ID=123456789
TELEGRAM_PUBLISH_CHANNEL_ID=-1009876543210
TELEGRAM_BOT_TOKEN=123456:bot_token
```

Message eligibility is controlled only by `parsing.filters`. To scan posts from one sender, add a filter that matches a sender or message field discovered with `/raw` or `/debug`.

## Launch Flow

Use this sequence for a new installation.

1. Install dependencies:

```bash
npm install
```

2. Create `.env` and fill Telegram credentials, source chat, target channel, admin user, and bot token:

```bash
cp .env.example .env
```

3. Create a local config only if you need to override defaults:

```bash
cp config.default.json config.json
```

4. Log in the userbot account with QR:

```bash
npm run session
```

5. Tune parsing rules in setup mode:

```bash
npm run setup
```

Then open a private chat with your bot from `TELEGRAM_ADMIN_ID` and run:

```text
/setup
/test 30
/raw 123456
/test_message 123456
/debug 123456
/preview 5 100
/done
```

After `/done`, stop setup mode with `Ctrl+C` or keep it running and open another terminal for the next commands.

6. Start the scheduled app:

```bash
npm start
```

7. Build the first database window from the admin bot:

```text
/backfill
```

`/backfill` scans `sync.initialScanDays`, adds missing old posts, and updates existing posts only inside `sync.refreshRecentDays`.

8. Check the admin stats:

```text
/stats
```

`/stats` works while `npm run setup` or `npm start` is running, because both start the admin bot.

9. Publish once manually from the admin bot:

```text
/publish weekly_best
```

To publish only one selection:

```text
/publish monthly_best
/publish weekly_best
/publish daily_best
```

If the same period was already scheduled or published, `/publish` reports that existing request instead of creating a duplicate. To intentionally publish the same selection again, use `--force` or `-force`:

```text
/publish weekly_best --force
/publish weekly_best -force
```

For later maintenance, usually run only `npm start`. Use admin `/sync` for one refresh pass, `/backfill 90` to fill a larger historical window, `/publish weekly_best` to manually publish one selection, and `npm run setup` when parser or template rules need to be changed.

## Configuration

Runtime options live in `config.default.json`. To override them, create a local `config.json` in the project root:

```bash
cp config.default.json config.json
```

`config.json` is deep-merged over `config.default.json`, so it can contain only the values you want to change. Keep secrets and Telegram IDs in `.env`.

Common options:

```json
{
  "logging": {
    "logLevel": "INFO",
    "color": "auto"
  },
  "sync": {
    "initialScanDays": 60,
    "refreshRecentDays": 7,
    "pageSize": 100,
    "intervalHours": 24,
    "runOnStart": true,
    "retentionDays": 60,
    "retentionInitialDelayMinutes": 15,
    "retentionIntervalHours": 24,
    "throttle": {
      "enabled": true,
      "historyMinMs": 800,
      "historyMaxMs": 1800,
      "mediaMinMs": 300,
      "mediaMaxMs": 900
    }
  },
  "publish": {
    "dryRun": false,
    "requestTtlHours": 12,
    "workerIntervalMinutes": 10,
    "sources": [
      {
        "key": "best",
        "where": "true"
      },
      {
        "key": "controversial",
        "where": "max(likes, dislikes) > 0"
      },
      {
        "key": "positive",
        "where": "likes > dislikes and likes >= 10"
      }
    ],
    "template": [
      {
        "source": "best",
        "key": "weekly_best",
        "enabled": true,
        "schedule": {
          "type": "weekly",
          "weekday": 1,
          "time": "10:10"
        },
        "windowHours": 168,
        "posts": {
          "target": 10,
          "min": 5,
          "max": 20
        },
        "reactions": {
          "strategy": "likes",
          "min": 10,
          "includeAbove": 30
        },
        "template": "Best posts for the last {{windowHours}}h ({{count}})"
      },
      {
        "source": "controversial",
        "key": "weekly_controversial",
        "enabled": true,
        "schedule": {
          "type": "weekly",
          "weekday": 1,
          "time": "11:10"
        },
        "windowHours": 168,
        "posts": {
          "target": 10,
          "min": 5,
          "max": 20
        },
        "reactions": {
          "strategy": "sum",
          "min": 10,
          "includeAbove": 30
        },
        "template": "Most controversial posts for the last {{windowHours}}h ({{count}})"
      },
      {
        "source": "positive",
        "key": "daily_positive",
        "enabled": true,
        "schedule": {
          "type": "daily",
          "time": "12:00"
        },
        "windowHours": 24,
        "posts": {
          "target": 5,
          "min": 2,
          "max": 10
        },
        "reactions": {
          "strategy": "likes",
          "min": 10,
          "includeAbove": 50
        },
        "template": "Positive posts for the last {{windowHours}}h ({{count}})"
      }
    ]
  },
  "schedule": {
    "enabled": true,
    "timezone": "Europe/Moscow"
  }
}
```

`logging.logLevel` can be `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT` and is case-insensitive. `logging.color` can be `auto`, `always`, or `never`; `auto` uses colors only for interactive terminals. Log levels are colored, scopes are highlighted, and high-signal fields such as `status`, `key`, `publicationId`, `messageId`, `reason`, and `error` get distinct colors. Sync logs include the scan window, each Telegram history request, fetched message counts, matched post counts, saved rows, skipped old posts, and deleted-post cleanup. `sync.runOnStart` controls whether the daemon runs one sync immediately after startup. `sync.intervalHours` controls the recurring sync interval. `sync.retentionDays` controls how long source post rows stay in `posts`; the default is 60 days. Retention starts after `sync.retentionInitialDelayMinutes` and then repeats every `sync.retentionIntervalHours`; it uses the same in-memory job gate as sync and publishing. Set `sync.runOnStart` to `false` to disable the initial startup sync.

Publication schedules use `schedule.timezone`. Each item under `publish.template` has a globally unique `key`, `source`, explicit `schedule`, `windowHours`, `posts`, `reactions`, and header `template`. `source` names an entry from `publish.sources`; `best` and `controversial` are the defaults, and you can add your own. Schedules can be daily (`{"type":"daily","time":"10:00"}`), weekly (`{"type":"weekly","weekday":1,"time":"10:00"}` with Monday as `1`), or monthly (`{"type":"monthly","dayOfMonth":15,"time":"10:00"}`; use days `1..28`). Selections use the rolling window `[scheduledAt - windowHours, scheduledAt)`.

Each `publish.sources[]` item has a unique `key` and a safe SQL-like `where` expression. Expressions can only use `likes`, `dislikes`, numeric literals, arithmetic/comparison/boolean operators, and `abs(...)`, `min(...)`, `max(...)`. They cannot access text, author, JSON data, message dates, or arbitrary SQL functions.

`posts.min <= posts.target <= posts.max`. Selection filtering and ordering happen inside SQLite. The DB applies the source `where`, computes the reaction score from `reactions.strategy`, filters by `reactions.min`, backfills to `posts.min` if too few posts pass, starts from `posts.target`, and expands up to `posts.max` when more posts meet `reactions.includeAbove`. Reaction strategies are `likes`, `dislikes`, `sum`, and `max`.

Publishing has two phases. The scheduler creates publication requests, then a worker sends queued requests one by one. `publish.workerIntervalMinutes` controls how often the worker checks the queue as a safety net; the default is 10 minutes. Publication creation also wakes the worker immediately, so this interval is mainly for catch-up if a wake-up was missed. `publish.requestTtlHours` controls how long a `created` or `running` request may wait before the worker marks it `failed`; the default is 12 hours. Sync and backfill are serialized in memory by one sync worker; overlapping sync/backfill requests are skipped.

## Userbot Login

Create the mtcute user session:

```bash
npm run session
```

The command prints a QR code in the terminal. Open Telegram on your phone and scan it from:

```text
Settings > Devices > Link Desktop Device
```

The session is stored at `telegram.sessionFile`, by default:

```text
sessions/mtcute-user.session
```

Run this again only when you change the Telegram account, remove the session file, or Telegram invalidates the session.

## Setup Mode

Before syncing a real database, use setup mode to tune parser rules against recent source messages:

```bash
npm run setup
```

Then open a private chat with your bot as `TELEGRAM_ADMIN_ID` and run:

```text
/setup
/test 30
/preview 5 100
/done
```

Useful setup commands:

```text
/setfilter {"source":"message","transform":"hasContent"}
/setfilter [{"source":"message","transform":"hasContent"},{"source":"sender","path":"id","transform":"equals","value":123456789}]
/addfilter {"source":"message","path":"message","transform":"contains","values":["/skip","#ignore"],"negate":true}
/addfilter {"source":"message","path":"message","regex":"#meme","transform":"bool"}
/setauthor {"source":"message","path":"message","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1}
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👍\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👎\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/settemplate postCaption {{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}
/settemplate selection.best.weekly_best.template Weekly community picks ({{count}})
/settemplate unknownAuthor anonymous
```

`/test N` reads the latest `N` source messages, applies the draft parser, and does not write anything to the database. `/raw MESSAGE_ID` fetches the current source message directly from Telegram and sends the raw object as a JSON file, which helps choose parser paths. `/test_message MESSAGE_ID` also fetches the current source message directly from Telegram, applies the current draft parser to that message, and shows the extracted fields. `/debug MESSAGE_ID` fetches the current source message directly from Telegram and sends a JSON file with a step-by-step parser trace for filters, paths, regexes, transforms, fallback reactions, and final parsed output. These commands do not read from SQLite. `/preview P M` scans the latest `M` messages, selects up to `P` weekly top posts, and sends them as rich posts with media and captions. `/done` saves the draft into `config.json`. If `config.json` already exists, it is copied to `config.json.old` first.

### Recommended Setup Workflow

1. Start setup mode:

```bash
npm run setup
```

2. Open a private chat with your bot as `TELEGRAM_ADMIN_ID` and start a draft:

```text
/setup
```

3. Start with a broad filter:

```text
/setfilter {"source":"message","transform":"hasContent"}
```

To keep only one sender, add a second filter that matches a field from `/raw` or `/debug`:

```text
/setfilter [{"source":"message","transform":"hasContent"},{"source":"sender","path":"id","transform":"equals","value":123456789}]
```

To exclude posts containing any marker, use a negated `contains` filter:

```text
/addfilter {"source":"message","path":"message","transform":"contains","values":["/skip","#ignore"],"negate":true}
```

4. Test recent messages:

```text
/test 30
```

5. Inspect a specific source message if parser paths are unclear:

```text
/raw 123456
/test_message 123456
/debug 123456
```

6. Add stricter filters or parser rules until the matched posts look correct.

7. Preview the post that would win the weekly selection:

```text
/preview 5 100
```

8. Save the final config:

```text
/done
```

9. Build the first database window with the saved config from the admin bot:

```text
/backfill
```

## Parsing Rules

The `parsing` section controls which messages are stored and how fields are extracted.

- `filters` decides whether a message is eligible.
- `author`, `likes`, and `dislikes` extract values. `author` means the parsed display author extracted by rules, not necessarily the Telegram sender.
- Extractors support `source`, `path`, `regex`, `group`, `transform`, and `aggregate`.
- Supported sources are `message` and `sender`.
- Paths can expand arrays with `[]`, for example `replyMarkup.rows[].buttons[].text`.

### Rule Shape

Most rules use this shape:

```json
{
  "source": "message",
  "path": "text",
  "regex": "#meme",
  "group": 0,
  "transform": "bool",
  "aggregate": "sum"
}
```

Fields:

- `source`: where to read data from. Use `message` or `sender`.
- `path`: dot path inside the source object. Optional; if omitted, the whole source object is used.
- `regex`: optional JavaScript regular expression string.
- `group`: regex capture group to use. Defaults to `0`.
- `transform`: converts the extracted value.
- `aggregate`: for numeric extractors. Use `sum` to add all matches.

### Filter Transforms

Filters return true or false. Useful transforms:

- `hasContent`: true when the message has text or media.
- `hasMedia`: true for photos, videos, and other supported media.
- `isPhoto`: true for photo messages.
- `isVideo`: true for video messages.
- `exists`: true when the value exists and is not empty.
- `notEmpty`: true when the string is not empty.
- `contains`: true when the value contains any configured `value` or `values` item.
- `equals`: true when the value equals any configured `value` or `values` item.
- `in`: alias for `equals`.
- `bool`: true for non-empty strings, non-zero numbers, and `true`.

Any filter can be inverted with `"negate": true` or `"not": true`. `contains`, `equals`, and `in` are case-insensitive by default; add `"caseSensitive": true` for strict matching.

Filter examples:

```text
/setfilter {"source":"message","transform":"hasContent"}
/setfilter {"source":"message","transform":"hasMedia"}
/setfilter {"source":"message","transform":"isPhoto"}
/setfilter {"source":"message","transform":"isVideo"}
/setfilter {"source":"message","path":"text","regex":"#meme","transform":"bool"}
/setfilter {"source":"sender","path":"id","transform":"equals","value":123456789}
/addfilter {"source":"message","path":"message","transform":"contains","values":["/skip","#ignore"],"negate":true}
```

Require both media and a hashtag:

```text
/setfilter [{"source":"message","transform":"hasMedia"},{"source":"message","path":"text","regex":"#meme","transform":"bool"}]
```

### Extractor Transforms

Extractor transforms are used for `author`, `likes`, and `dislikes`. The `author` extractor controls the display author used in captions:

- `trim`
- `count`
- `telegramUsername`

Extractor examples:

```text
/setauthor {"source":"message","path":"text","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1,"transform":"trim"}
/setauthor [{"source":"message","path":"text","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1,"transform":"trim"},{"source":"sender","path":"firstName","transform":"trim"}]
/setauthor {"source":"sender","path":"username","regex":"(.+)","group":1,"transform":"telegramUsername"}
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👍\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👎\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
```

Custom button labels:

```text
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"like=([\\d.,k]+)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"dislike=([\\d.,k]+)","group":1,"transform":"count","aggregate":"sum"}
```

### Useful Message Paths

Depending on the source message shape, useful paths may include:

- `text`
- `message`
- `sender.firstName`
- `sender.username`
- `markup.buttons[].text`
- `replyMarkup.rows[].buttons[].text`

If a path does not match anything, run `/test 30` with a broader filter and adjust the path. The project keeps compatibility with mtcute-style fields and older Telegram-client field names where possible.

## Templates

Published captions and admin stats can be customized in `templates`. Selection headers are configured in the matching item inside `publish.template`.

Example:

```json
{
  "templates": {
    "publish": {
      "postCaption": "{{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}",
      "unknownAuthor": "unknown",
      "maxTextLength": 700
    }
  },
  "publish": {
    "template": [
      {
        "source": "best",
        "key": "weekly_best",
        "template": "Best posts for the last {{windowHours}}h ({{count}})"
      },
      {
        "source": "controversial",
        "key": "weekly_controversial",
        "template": "Most controversial posts for the last {{windowHours}}h ({{count}})"
      }
    ]
  }
}
```

Post caption variables:

- `position`
- `author`: extracted display author, not necessarily the Telegram sender
- `likes`
- `dislikes`
- `score`
- `text`
- `messageId`
- `chatId`
- `mediaCount`
- `mediaIds`
- `mediaSummary`

Setup mode can edit templates with:

```text
/settemplate <key> <value>
```

Supported keys:

- `postCaption`
- `unknownAuthor`
- `maxTextLength`
- `selection.best.monthly_best.template`
- `selection.best.weekly_best.template`
- `selection.best.daily_best.template`
- `selection.controversial.monthly_controversial.template`
- `selection.controversial.weekly_controversial.template`
- `selection.controversial.daily_controversial.template`
- `stats.summary`
- `stats.topPost`

Examples:

```text
/settemplate postCaption #{{position}} {{author}} | 👍 {{likes}} 👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}
/settemplate selection.best.monthly_best.template Best posts for {{windowHours}}h ({{count}})
/settemplate selection.controversial.weekly_controversial.template Controversial posts for {{windowHours}}h ({{count}})
/settemplate maxTextLength 500
/settemplate stats.topPost Top month post: #{{messageId}}, score {{score}}
```

Run `/preview P M` after changing templates to see the final rendered rich posts. Setup preview sends media content to the admin private chat, but does not publish anything to the target channel and does not write publication records.

## Command Reference

Create or refresh the mtcute user session:

```bash
npm run session
```

Start setup mode for parser and template tuning:

```bash
npm run setup
```

Run one recent refresh pass from the admin bot. This updates posts inside `sync.refreshRecentDays` and removes recently deleted source posts from the local database:

```text
/sync
```

Backfill missing posts for `sync.initialScanDays` without rewriting older existing rows from the admin bot:

```text
/backfill
```

Backfill a custom number of days:

```text
/backfill 90
```

Backfill adds missing posts from the requested period. Existing posts are updated only inside `sync.refreshRecentDays`; older existing rows are left unchanged. If sync or backfill is already running, the new request is skipped.

Run one publish cycle from the admin bot without running sync first. A selection argument is required; `/publish` without arguments prints command help and does not schedule anything.

```text
/publish weekly_best
```

Publish only one best selection:

```text
/publish monthly_best
/publish weekly_best
/publish daily_best
```

Because template keys are globally unique, `/publish weekly_best` is equivalent to `/publish best.weekly_best`. Any configured source can also be addressed as `source.key`:

```text
/publish controversial.monthly_controversial
/publish controversial.weekly_controversial
/publish controversial.daily_controversial
/publish positive.daily_positive
```

Multiple selection types can be passed in one command:

```text
/publish best.weekly_best controversial.weekly_controversial
/publish best.*
/publish controversial.*
/publish positive.*
```

If a selection for the same period already exists, the command replies with the existing status and does not fail. To schedule another copy anyway, add `--force` or `-force`; the app will create a unique forced publication key:

```text
/publish best.weekly_best --force
/publish best.weekly_best -force
```

Run the daemon for normal operation:

```bash
npm start
```

The daemon starts the admin bot, runs sync on startup when `sync.runOnStart` is enabled, schedules sync by `sync.intervalHours`, and schedules each publication type by local time. On startup it also checks for recently missed publication times. If a scheduled run was missed while the daemon was stopped and it is still inside `publish.requestTtlHours`, the daemon creates the publication request and runs the publication worker. Older missed runs are skipped.

## Running With PM2

The repository includes `ecosystem.example.json` for running the daemon with PM2.

Install PM2 if needed:

```bash
npm install -g pm2
```

Start the daemon from the project root:

```bash
pm2 start ecosystem.example.json
```

Check logs:

```bash
pm2 logs tg-memes
```

Restart after changing `.env` or `config.json`:

```bash
pm2 restart tg-memes
```

Enable startup on server reboot:

```bash
pm2 startup
pm2 save
```

If you want to customize the PM2 process name, memory limit, or other options, copy the example first:

```bash
cp ecosystem.example.json ecosystem.config.json
pm2 start ecosystem.config.json
```

## Admin Bot Commands

Commands work only in a private chat with `TELEGRAM_ADMIN_ID`.

```text
/stats
/jobs
/publications
/publication <id>
/sync
/backfill
/publish
/setup
```

`/jobs` shows all active publication jobs and the last 5 terminal jobs, sorted by `updated_at`, including progress and the latest error.

`/publications` shows the last 10 publication records with IDs, status, selection, progress, update time, and title. `/publication <id>` shows the posts for one publication as an aligned table with source message IDs, reactions, send status, bot message ID, and parsed author.

`/sync` runs one recent refresh pass. `/backfill [days]` fills missing historical posts. Both commands use the in-memory sync worker, so overlapping sync/backfill requests are skipped. `/publish [key...]` creates publication request rows immediately. If at least one request was created, the publication worker is asked to process the queue; the worker still runs one job at a time.

Other users and non-private chats are ignored.

## Data Storage

SQLite files are stored locally. By default:

```text
data/posts.sqlite
```

Main tables:

- `posts`
- `publications`
- `publication_posts`

Publication rows use a durable `key` per selection period. Scheduled publishing creates `created` requests; the worker sends the header, switches the request to `running`, records each sent post in `publication_posts`, and finally marks the request `published`. If the process restarts while a request is `running`, the worker resumes from the first post that was not recorded as sent. Expired requests are marked `failed`.

The daemon periodically deletes rows in `posts` older than `sync.retentionDays` so the database does not grow indefinitely. Retention waits 15 minutes after daemon startup by default, then runs every 24 hours, and it is serialized through the same job gate as sync and publishing. Publication history remains in `publications` and `publication_posts`; old publication post details may no longer have joined source text/author after the source post row is pruned.

Media is not stored permanently. The database stores Telegram media references in `data.media`; media is downloaded to `sync.mediaDir` only for preview or publishing and deleted immediately after the rich post is sent or the send attempt fails.

Telegram can return `FLOOD_WAIT` for read-only API calls too, including history reads and media downloads. The app retries after the requested wait and also adds a small random delay before Telegram read calls. Tune `sync.throttle.historyMinMs` / `historyMaxMs` for scanning and `sync.throttle.mediaMinMs` / `mediaMaxMs` for preview and publishing media downloads.

## Limitations

- Telegram does not provide stable public CDN URLs for private media available to a userbot.
- Parser paths can differ between Telegram message layouts, so setup mode should be used before the first sync.
- Deleted old posts are detected only inside the configured refresh window.
- The included PM2 file is only an example; adjust paths and environment handling for your server.

## Development

Run tests:

```bash
npm test
```
