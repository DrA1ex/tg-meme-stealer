# tg-meme-stealer

Telegram rankings bot for communities where a regular bot cannot be added to the source group.

`tg-memes` logs in as a regular Telegram user with [mtcute](https://mtcute.dev), scans posts from a source chat, stores post stats in SQLite, and publishes ranked selections to a target channel through a Telegram bot powered by Telegraf.

It supports text posts, photos, videos, albums, configurable parsing rules, QR login, scheduled publishing, and an admin-only setup mode for tuning content parsing and publishing before the first real sync.

## Features

- Scans a Telegram group or channel with a user account.
- Supports QR login for the userbot session.
- Stores posts in SQLite with `chat_id`, `message_id`, extracted `author`, `text`, `likes`, `dislikes`, and structured `data`.
- Handles text posts, photos, videos, and albums.
- Refreshes recent posts because like/dislike counters can change.
- Removes recently deleted source posts from the local database.
- Publishes configurable top selections to a target Telegram channel.
- Publishes configurable controversial selections from rolling time windows.
- Supports configurable publication sources, rolling windows, thresholds, and schedules.
- Keeps a publication log in SQLite and resumes interrupted publication jobs.
- Provides admin-only bot commands for stats, sync, backfill, publishing, and setup.
- Includes a button-driven setup assistant for content rules, publishing schedules, diagnostics, and safe draft saving.
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

# Optional: coordinate rate limits between processes.
# RATE_LIMIT_REDIS_ENABLED=true
# RATE_LIMIT_REDIS_URL=redis://127.0.0.1:6379
```

Message eligibility is controlled only by `parsing.filters`. To scan posts from one sender, add a filter that matches a sender or message field discovered with setup diagnostics, `/raw`, or `/debug`.

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

5. Tune content and publishing rules in setup mode:

```bash
npm run setup
```

Then open a private chat with your bot from `TELEGRAM_ADMIN_ID` and run:

```text
/setup
```

Use the button menu instead of writing JSON by hand. A typical first setup pass is:

```text
/setup
→ Content setup
→ Quick setup
→ Review Filters / Author / Reactions if needed
→ Test content
→ Preview
→ Publishing setup
→ Recommended presets or Traffic suggestions
→ Schedule preview / Schedule doctor
→ Check & save
→ Save
```

Diagnostics are available from the setup home screen. Use `Diagnostics → Message browser` to inspect concrete source messages, including lookup by Telegram message id.

The old text commands such as `/setfilter`, `/raw`, `/debug`, `/preview`, and `/done` still work in setup mode, but they are now best treated as advanced/manual tools.

After saving, stop setup mode with `Ctrl+C` or keep it running and open another terminal for the next commands.

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

For later maintenance, usually run only `npm start`. Use admin `/sync` for one refresh pass, `/backfill 90` to fill a larger historical window, `/publish weekly_best` to manually publish one selection, and `npm run setup` when parser, publishing, source, or template rules need to be changed.

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
  "rateLimit": {
    "mtprotoGroup": "local",
    "maxQueueDelayMs": 300000,
    "longWaitWarnMs": 10000,
    "telegramOperationTimeoutMs": 60000,
    "redis": {
      "enabled": false,
      "mode": "standalone",
      "url": "redis://127.0.0.1:6379",
      "keyPrefix": "tg-memes:local",
      "connectTimeoutMs": 500,
      "operationTimeoutMs": 200,
      "circuitBreakMs": 5000,
      "fallbackMultiplier": 3,
      "penaltyQuietPeriodMs": 60000,
      "penaltyDecayIntervalMs": 30000
    }
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
      "mediaMaxMs": 900,
      "reactionsMinMs": 3000,
      "reactionsMaxMs": 4000,
      "retryBufferMs": 1000
    }
  },
  "publish": {
    "dryRun": false,
    "throttle": {
      "enabled": true,
      "perChatMinMs": 1100,
      "globalMinMs": 40,
      "sharedDestinationMinMs": 350,
      "shareRetryAfterAcrossBots": false,
      "retryBufferMs": 1000
    },
    "requestTtlHours": 12,
    "workerLeaseMs": 900000,
    "workerIntervalMinutes": 10,
    "firstSendAt": "2026-07-01T00:00:00+03:00",
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
        "firstSendAt": "2026-07-01T10:10:00+03:00",
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

Publication schedules use `schedule.timezone`. Each item under `publish.template` has a globally unique `key`, `source`, explicit `schedule`, `windowHours`, optional `offsetHours`, `posts`, `reactions`, and header `template`. `source` names an entry from `publish.sources`; `best` and `controversial` are the defaults, and you can add your own. Schedules can be daily (`{"type":"daily","time":"10:00"}`), weekly (`{"type":"weekly","weekday":1,"time":"10:00"}` with Monday as `1`), or monthly (`{"type":"monthly","dayOfMonth":15,"time":"10:00"}`; use days `1..28`). Selections normally use the rolling window `[scheduledAt - windowHours, scheduledAt)`.

Set `offsetHours` to move only the selection window back from the scheduled run time. For example, `windowHours: 24` and `offsetHours: 168` on a run at `2026-07-08T10:00:00Z` selects posts from `[2026-06-30T10:00:00Z, 2026-07-01T10:00:00Z)`, while the publish key, first-send gate, and send time remain tied to `2026-07-08T10:00:00Z`.

Set optional `publish.firstSendAt` to stage a daemon without publishing older missed periods. Scheduled runs and normal `/publish` calls before that timestamp are skipped; `/publish <key> -force` can still publish earlier. Use an ISO date string, preferably with an explicit timezone offset, for example `"2026-07-01T00:00:00+03:00"`.

You can also set `firstSendAt` on an individual `publish.template` item. If both global and template values are present, the later timestamp wins. For example, global `"2026-10-01T00:00:00+03:00"` and template `"2026-01-01T00:00:00+03:00"` means the template will not publish normally until October 1, 2026.

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

Setup mode starts the admin bot and lets one admin build a temporary draft config before it is written to `config.json`:

```bash
npm run setup
```

Open a private chat with the bot as `TELEGRAM_ADMIN_ID` and run:

```text
/setup
```

`/setup` creates a draft from the currently loaded config and opens `Setup home`. Changes are pending until you press `Save` or run `/done`. `Cancel` or `/cancel` drops the draft. When saving, the current `config.json` is backed up to `config.json.old` first.

### Setup Home

The home screen is navigation, not a status screen. It shows a short draft summary and these main areas:

```text
Content setup
Publishing setup
Diagnostics
Check & save
Advanced
Save / Cancel
```

Use `Home` to return to this screen. Use `Status` only when you want a health summary of the current draft.

### Content Setup

`Content setup` controls which Telegram messages become posts and how `author`, `likes`, and `dislikes` are extracted.

Recommended path:

```text
Content setup
→ Quick setup
→ Review filters / author / reactions
→ Test content
→ Preview
```

Manual sections:

- `Filters`: choose or reset eligibility rules. Filters only decide whether a source message can become a candidate post.
- `Author`: choose how `{{author}}` is extracted for published captions.
- `Reactions`: choose button counters or native Telegram reactions for likes/dislikes.

Each section has `Pending Config`, which shows only the relevant draft snippet with unsaved changes applied:

```text
Filters → pending parsing.filters
Author  → pending parsing.author
Reactions → pending parsing.likes + parsing.dislikes
```

`Pending Content Config` shows the full pending `parsing` draft. `Saved Content Config` shows the config loaded from disk, so you can compare pending changes with the saved state.

Reaction options are intentionally shown as separate modes even when they produce the same result on the current sample:

- `buttons · detected markers`: uses markers discovered in inline button labels.
- `buttons · conservative`: prefers common positive/negative markers such as 👍 and 👎.
- `buttons · broad`: uses a broader emoji set.
- `buttons · except 👎💩🤡 is like`: counts any numeric button label except configured negative markers as likes, and counts those negative markers as dislikes.
- `native · conservative`, `native · broad`, and `native · except 👎💩🤡 is like`: read Telegram native reaction counters instead of button text.

The reaction option legend is:

```text
★ = suggested best guess from the current sample
✓ = current selected option
≈ = same config result as selected on this sample, but not the selected option
• = available option
◆ = custom Telegram reaction
```

Manual choices in Filters, Author, and Reactions are applied directly to the pending draft. They do not go through the `Apply suggested` confirmation screen; that screen is only for Quick setup / Suggestions.

### Publishing Setup

`Publishing setup` controls publication sources, schedules, rolling windows, post counts, and reaction thresholds.

Main paths:

- `Recommended presets`: apply built-in publish template presets.
- `Traffic suggestions`: scan recent/database traffic and suggest practical schedules.
- `Manual schedule`: create a schedule step by step from source, cadence, weekday/day, time, window, post count, and threshold.
- `Sources`: enable/disable source presets, add a custom source expression, reset sources, or run `Source test`.
- `Schedules`: enable, disable, or remove existing publish templates.
- `Schedule preview`: show upcoming runs.
- `Schedule doctor`: check schedule/template problems.
- `Publish config`: show the pending publishing draft. This is not necessarily saved yet.

`publish.sources[]` are named SQL-like filters over stored reaction fields. `publish.template[]` entries reference sources by key and define schedule, window, selection limits, reaction thresholds, and header template.

### Diagnostics

Diagnostics are available from `Setup home` because they can be useful for both content setup and publishing checks.

Diagnostic sections:

- `Why matched?`: show parser trace for a message that matched current rules.
- `Why rejected?`: show parser trace for a rejected message.
- `Unknown author?`: focus on messages where author extraction failed.
- `Zero likes?`: focus on messages where reaction extraction produced zero.
- `Message browser`: inspect loaded sample messages page by page.
- `Reaction fields`: show likely reaction/button paths.
- `Author fields`: show likely author fields.
- `Raw / advanced tools`: field scan, message shape, raw matched messages, raw reactions, pending content config, and advanced JSON.

`Message browser` can open messages from the loaded setup sample or by Telegram message id. `View by message ID` first searches the loaded setup context/cache. If the message is not there, it requests the message from the configured source chat through the userbot scanner. The lookup result explicitly says whether the message was found in context, loaded from Telegram, not found, or failed with a Telegram error.

Single-message view supports these modes:

- `Overview`: parsed status, author/reaction summary, and useful message metadata.
- `Raw reactions`: raw button/native reaction data for that message.
- `Message shape`: compact structural view of the Telegram message object.
- `Parsed preview`: sends a separate rich preview post for that message if it matches current filters.
- `Back to Message Browser`: returns to the browser page you came from.

`Overview`, `Raw reactions`, and `Message shape` edit the same setup message. `Parsed preview` sends a new preview message because it may contain media and a rendered caption.

### Check & Save

Use `Check & save` before writing the draft to disk:

```text
Status
Doctor
Test content
Preview
Show last change
Save / Cancel
```

Recommended order:

1. `Status`: read the concise draft summary.
2. `Doctor`: catch obvious content, source, and schedule issues.
3. `Test content`: parse recent source messages without writing to SQLite.
4. `Preview`: send rich preview posts to the admin chat without publishing to the target channel.
5. `Save`: write `config.json` after the draft looks correct.

Setup tracks whether content or publishing changed after the last test/preview and warns when preview is stale.

### Text Commands in Setup Mode

The button UI is the normal path, but setup mode still accepts text commands for exact JSON edits or debugging:

```text
/setup
/setup home
/setup status
/setup check
/setup save
/setup cancel
/setup suggestions
/setup presets

/setfilter {jsonRuleOrArray}
/addfilter {jsonRuleOrArray}
/setauthor {jsonRuleOrArray}
/setlikes {jsonRuleOrArray}
/setdislikes {jsonRuleOrArray}
/setsources [{"key":"best","where":"true"}]
/setsource {"key":"positive","where":"likes > dislikes"}
/setpublish {"source":"positive","key":"daily_positive","enabled":false,"schedule":{"type":"daily","time":"12:00"},"windowHours":24,"offsetHours":0,"posts":{"min":1,"target":3,"max":5},"reactions":{"strategy":"likes","min":0,"includeAbove":999999},"template":"Positive posts ({{count}})"}
/settemplate templates.publish.postCaption {{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}
/test 30
/raw 123456
/test_message 123456
/debug 123456
/preview 5 100
/done
/cancel
```

`/test N` reads the latest `N` source messages, applies the draft parser, and does not write anything to the database. `/raw MESSAGE_ID` fetches the current source message directly from Telegram and sends the raw object as a JSON file. `/test_message MESSAGE_ID` fetches one source message and applies the current draft parser. `/debug MESSAGE_ID` fetches one source message and sends a JSON file with a step-by-step parser trace for filters, paths, regexes, transforms, fallback reactions, and final parsed output. `/preview P M` scans the latest `M` messages, selects up to `P` weekly top posts, and sends them as rich posts with media and captions. `/done` is the text-command equivalent of `Save`.

### Recommended Setup Workflow

For a new source chat, use the button flow first:

1. Start setup mode:

```bash
npm run setup
```

2. Open a private chat with your bot as `TELEGRAM_ADMIN_ID` and start a draft:

```text
/setup
```

3. Open `Content setup → Quick setup`. Apply the recommended parser setup if it looks right.

4. Review `Filters`, `Author`, and `Reactions` manually if the suggested setup is not enough. Use each section's `Pending Config` to confirm the pending draft snippet.

5. Run `Test content`. If the match set is wrong, adjust filters or use `Diagnostics → Why rejected?` / `Why matched?`.

6. Open `Diagnostics → Message browser` if a concrete source message behaves unexpectedly. Use `View by message ID` to fetch a message that is not in the current sample.

7. Run `Preview` and inspect the rendered posts in the admin chat.

8. Open `Publishing setup`. Use `Recommended presets`, `Traffic suggestions`, or `Manual schedule`, then run `Schedule preview` and `Schedule doctor`.

9. Open `Check & save`, then run `Status`, `Doctor`, `Test content`, and `Preview` once more if the draft changed.

10. Press `Save` or run `/done`.

11. Build the first database window with the saved config from the admin bot:

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
- `reactionCount`
- `mentionAuthor`
- `telegramUsername`

`count` parses numbers from text, including common compact suffixes handled by the parser. It is normally used for inline button labels such as `👍 12` or `12 👍`.

`reactionCount` reads Telegram native reaction objects. It accepts an `emojis` array. If `invert` is true, the rule counts every reaction except the listed emojis. This is how the native `except 👎💩🤡 is like` setup option is represented.

Extractor examples:

```text
/setauthor {"source":"message","path":"text","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1,"transform":"trim"}
/setauthor [{"source":"message","path":"text","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1,"transform":"trim"},{"source":"sender","path":"firstName","transform":"trim"}]
/setauthor {"source":"sender","path":"username","regex":"(.+)","group":1,"transform":"telegramUsername"}
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👍\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👎\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/setlikes {"source":"message","path":"reactionCounts[]","transform":"reactionCount","emojis":["👍","❤","❤️","🔥"],"aggregate":"sum"}
/setdislikes {"source":"message","path":"reactionCounts[]","transform":"reactionCount","emojis":["👎"],"aggregate":"sum"}
```

Custom button labels:

```text
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"like=([\\d.,k]+)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"dislike=([\\d.,k]+)","group":1,"transform":"count","aggregate":"sum"}
```

Button labels where any non-negative counted button means like:

```text
/setlikes {"source":"message","path":"markup.buttons[].text","regex":"^(?!.*(?:👎|💩|🤡|-)).*?([\\d\\s,.]+[km]?).*$","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"markup.buttons[].text","regex":"(?:👎|💩|🤡|-)\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
```

Native reactions where every emoji except negative markers counts as likes:

```text
/setlikes {"source":"message","path":"reactionCounts[]","transform":"reactionCount","emojis":["👎","💩","🤡"],"invert":true,"aggregate":"sum"}
/setdislikes {"source":"message","path":"reactionCounts[]","transform":"reactionCount","emojis":["👎","💩","🤡"],"aggregate":"sum"}
```

### Useful Message Paths

Depending on the source message shape, useful paths may include:

- `text`
- `message`
- `sender.firstName`
- `sender.lastName`
- `sender.username`
- `markup.buttons[].text`
- `replyMarkup.rows[].buttons[].text`
- `reactionCounts[]`
- `nativeReactions[]`
- `messageReactions.results[]`
- `reactions.results[]`

Button paths are used with `transform: "count"`. Native reaction paths are used with `transform: "reactionCount"`.

If a path does not match anything, use `Diagnostics → Reaction fields`, `Diagnostics → Author fields`, or `Diagnostics → Message browser`. The project keeps compatibility with mtcute-style fields and older Telegram-client field names where possible.

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

Selection header variables:

- `key`, `source`, `type`, `templateKey`, `period`
- `count`, `limit`, `posts`, `reactions`
- `windowHours`
- `offsetHours`
- `windowStart`: ISO timestamp for the actual selection window start
- `windowEnd`: ISO timestamp for the actual selection window end
- `scheduledAt`: ISO timestamp for the publish run time

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

- `templates.publish.postCaption`
- `templates.publish.unknownAuthor`
- `templates.publish.maxTextLength`
- `publish.template.monthly_best.template`
- `publish.template.weekly_best.template`
- `publish.template.daily_best.template`
- `publish.template.monthly_controversial.template`
- `publish.template.weekly_controversial.template`
- `publish.template.daily_controversial.template`
- `templates.stats.summary`
- `templates.stats.topPost`

Examples:

```text
/settemplate templates.publish.postCaption #{{position}} {{author}} | 👍 {{likes}} 👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}
/settemplate publish.template.monthly_best.template Best posts for {{windowHours}}h ({{count}})
/settemplate publish.template.weekly_controversial.template Controversial posts for {{windowHours}}h ({{count}})
/settemplate templates.publish.maxTextLength 500
/settemplate templates.stats.topPost Top month post: #{{messageId}}, score {{score}}
```

Setup mode can also edit the publication format directly:

```text
/setsources [{"key":"best","where":"true"},{"key":"controversial","where":"abs(likes - dislikes) < max(likes, dislikes) * 0.3"}]
/setsource {"key":"positive","where":"likes > dislikes"}
/setpublish {"source":"positive","key":"daily_positive","enabled":false,"schedule":{"type":"daily","time":"12:00"},"windowHours":24,"offsetHours":0,"posts":{"min":1,"target":3,"max":5},"reactions":{"strategy":"likes","min":0,"includeAbove":999999},"template":"Positive posts ({{count}})"}
```

Run `/preview P M` after changing templates to see the final rendered rich posts. Setup preview sends media content to the admin private chat, but does not publish anything to the target channel and does not write publication records.

## Command Reference

Create or refresh the mtcute user session:

```bash
npm run session
```

Start setup mode for parser, publishing, source, and template tuning:

```bash
npm run setup
```

Inside the admin private chat, `/setup` opens the button-driven setup home. Useful setup actions are also available as text aliases:

```text
/setup
/setup home
/setup status
/setup check
/setup suggestions
/setup presets
/setup save
/setup cancel
```

Use the buttons for normal setup. Use the JSON commands documented in `Setup Mode → Text Commands in Setup Mode` only when you need exact manual edits.

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

`firstSendAt` also applies to manual publishing. If a selection has not reached its first allowed send time yet, `/publish weekly_best` reports that it was skipped. Use `-force` only when you intentionally want to publish an earlier period.

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
/setup status
/setup check
/setup save
/setup cancel
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

Telegram can return `FLOOD_WAIT` for read-only API calls too, including history reads, reaction enrichment, and media downloads. All MTProto traffic shares one adaptive limiter: calls are paced per method, a server-requested wait pauses the whole client, and the affected method backs off before slowly returning to its configured rate. Tune `sync.throttle.historyMinMs` / `historyMaxMs`, `reactionsMinMs` / `reactionsMaxMs`, and `mediaMinMs` / `mediaMaxMs` as needed.

Reaction enrichment is requested only when `parsing.filters`, `parsing.author`, `parsing.likes`, or `parsing.dislikes` contains a native-reaction path or uses `transform: "reactionCount"`. Button-only parsing avoids the extra `getMessageReactions` request entirely.

Bot API publishing is rate-limited separately. The defaults keep sends to one chat 1100 ms apart (just below Telegram's documented average limit of one message per second), cap aggregate traffic at 25 requests per second, and extend either limiter automatically when Telegram returns `retry_after`. Configure this under `publish.throttle` with `perChatMinMs`, `globalMinMs`, and `retryBufferMs`.

### Optional shared Redis rate limiter

Multiple PM2 processes can coordinate their rate limits through Redis. Redis is disabled by default; without it every process continues to use its in-memory limiter. To enable coordination, set the same values in every instance:

```dotenv
RATE_LIMIT_REDIS_ENABLED=true
RATE_LIMIT_REDIS_URL=redis://127.0.0.1:6379
```

Set `rateLimit.redis.keyPrefix` and `rateLimit.mtprotoGroup` in `config.json`; they are intentionally not environment variables. Both must be explicit when Redis is enabled. Processes with the same MTProto group share reservations, adaptive penalties, and `FLOOD_WAIT` cooldowns. Use the same group only when the processes use the same Telegram user account. Only standalone Redis is supported; Redis Cluster is rejected by config validation.

Bot API global and per-chat quotas remain scoped to each bot token, while `publish.throttle.sharedDestinationMinMs` spaces sends from all bots targeting the same chat. A `retry_after` blocks only the bot token that received it by default; set `shareRetryAfterAcrossBots` only if Telegram has demonstrably applied a destination-wide restriction.

Normal Redis operations and immediate slot acquisitions are logged at `DEBUG`, including operation latency, scopes, and the PM2/process id. Actual waits are logged at `INFO`, waits above `longWaitWarnMs` at `WARN`, and waits above `maxQueueDelayMs` are rejected. `FLOOD_WAIT` and Bot API `retry_after` are logged at `WARN`.

If Redis cannot be reached or an operation times out, the app logs an `ERROR`, opens a short circuit breaker, and continues through a conservative local fallback. MTProto and Bot API token/chat intervals are multiplied by `fallbackMultiplier`; Bot API destination sends also receive a randomized fallback delay. A timed-out Redis operation is treated as indeterminate rather than as a confirmed failure. Before every Telegram request, a process validates that no newer shared cooldown invalidated its reservation. Repeated outage messages are reduced to `DEBUG` between periodic `ERROR` reminders; recovery is logged at `INFO`.

The Redis integration test is mandatory in GitHub Actions. Locally, set `TEST_REDIS_URL` to run the same real-server concurrency and cooldown tests.

Every limiter wait has one cumulative `maxQueueDelayMs` budget, including Redis revalidation. Telegram operations have a `telegramOperationTimeoutMs` watchdog. Publication workers coordinate through SQLite leases (`publish.workerLeaseMs`), and interrupted sends are moved to `uncertain` instead of being retried automatically; inspect those jobs before deciding whether to resend. Sync pagination also stops on repeated cursors or after `sync.maxPagesPerRun` pages.

## Limitations

- Telegram does not provide stable public CDN URLs for private media available to a userbot.
- Parser paths can differ between Telegram message layouts, so setup mode should be used before the first sync.
- Deleted old posts are detected only inside the configured refresh window.
- The included PM2 file is only an example; adjust paths and environment handling for your server.

## Development

Run all tests:

```bash
npm test
```

Run only setup-related tests with coverage over the setup assistant and setup modules:

```bash
npm run test:setup
```
