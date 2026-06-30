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
- Publishes top selections to a target Telegram channel:
  - best posts from the last month;
  - best posts from the last week;
  - best fresh posts from the last 24 hours.
- Publishes controversial selections where likes and dislikes are close by a configurable threshold.
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

6. Build the first database window:

```bash
npm run backfill
```

`backfill` scans `sync.initialScanDays`, adds missing old posts, and updates existing posts only inside `sync.refreshRecentDays`.

7. Check the admin stats:

```text
/stats
```

`/stats` works while `npm run setup` or `npm start` is running, because both start the admin bot.

8. Publish once manually:

```bash
npm run publish
```

To publish only one selection:

```bash
npm run publish -- month
npm run publish -- week
npm run publish -- day
```

9. Start the scheduled app:

```bash
npm start
```

For later maintenance, usually run only `npm start`. Use `npm run sync` for one refresh pass, `npm run backfill -- 90` to fill a larger historical window, `npm run publish -- week` to manually publish one selection, and `npm run setup` when parser or template rules need to be changed.

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
    "level": "info"
  },
  "sync": {
    "initialScanDays": 60,
    "refreshRecentDays": 7,
    "pageSize": 100,
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
    "selections": {
      "best": {
        "week": {
          "enabled": true,
          "time": "10:10",
          "limit": 10,
          "template": "Best posts from the last week ({{count}})"
        }
      },
      "controversial": {
        "week": {
          "enabled": true,
          "time": "11:10",
          "limit": 10,
          "threshold": 0.3,
          "template": "Most controversial posts from the last week ({{count}})"
        }
      }
    }
  },
  "schedule": {
    "timezone": "Europe/Moscow",
    "syncIntervalHours": 24
  }
}
```

`logging.level` can be `debug`, `info`, `warn`, `error`, or `silent`. Sync logs include the scan window, each Telegram history request, fetched message counts, matched post counts, saved rows, skipped old posts, and deleted-post cleanup.

Publication schedules use `schedule.timezone`. Each enabled selection under `publish.selections` has its own local `time`, `limit`, and header `template`. The `day` period uses `windowHours`; controversial selections also use `threshold`. A threshold of `0.3` means likes and dislikes may differ by at most 30% of the larger reaction count.

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
/settemplate selection.best.week.template Weekly community picks ({{count}})
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

9. Build the first database window with the saved config:

```bash
npm run backfill
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

Published captions and admin stats can be customized in `templates`. Selection headers are configured in `publish.selections.*.*.template`.

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
    "selections": {
      "best": {
        "week": {
          "template": "Best posts from the last week ({{count}})"
        }
      },
      "controversial": {
        "week": {
          "template": "Most controversial posts from the last week ({{count}})"
        }
      }
    }
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
- `selection.best.month.template`
- `selection.best.week.template`
- `selection.best.day.template`
- `selection.controversial.month.template`
- `selection.controversial.week.template`
- `selection.controversial.day.template`
- `stats.summary`
- `stats.topPost`

Examples:

```text
/settemplate postCaption #{{position}} {{author}} | 👍 {{likes}} 👎 {{dislikes}}\nMedia: {{mediaSummary}}\n\n{{text}}
/settemplate selection.best.month.template Best posts this month ({{count}})
/settemplate selection.controversial.week.template Controversial posts this week ({{count}})
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

Run one recent refresh pass. This updates posts inside `sync.refreshRecentDays` and removes recently deleted source posts from the local database:

```bash
npm run sync
```

Backfill missing posts for `sync.initialScanDays` without rewriting older existing rows:

```bash
npm run backfill
```

Backfill a custom number of days:

```bash
npm run backfill -- 90
```

Backfill adds missing posts from the requested period. Existing posts are updated only inside `sync.refreshRecentDays`; older existing rows are left unchanged.

Run one publish cycle without running sync first. Without arguments this publishes all enabled selections.

```bash
npm run publish
```

Publish only one best selection:

```bash
npm run publish -- month
npm run publish -- week
npm run publish -- day
```

These short aliases map to `best.month`, `best.week`, and `best.day`. Publish controversial selections with explicit keys:

```bash
npm run publish -- controversial.month
npm run publish -- controversial.week
npm run publish -- controversial.day
```

Multiple selection types can be passed in one command:

```bash
npm run publish -- best.week controversial.week
```

Run sync and publish once:

```bash
npm run once
```

Run the daemon for normal operation:

```bash
npm start
```

The daemon starts the admin bot, runs sync on startup when `schedule.runOnStart` is enabled, schedules sync by interval, and schedules each publication type by local time.

## Admin Bot Commands

Commands work only in a private chat with `TELEGRAM_ADMIN_ID`.

```text
/stats
/setup
```

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

Media is not stored permanently. The database stores Telegram media references in `data.media`; media is downloaded to `sync.mediaDir` only for preview or publishing and deleted immediately after the rich post is sent or the send attempt fails.

Telegram can return `FLOOD_WAIT` for read-only API calls too, including history reads and media downloads. The app retries after the requested wait and also adds a small random delay before Telegram read calls. Tune `sync.throttle.historyMinMs` / `historyMaxMs` for scanning and `sync.throttle.mediaMinMs` / `mediaMaxMs` for preview and publishing media downloads.

## Limitations

- Telegram does not provide stable public CDN URLs for private media available to a userbot.
- Parser paths can differ between Telegram message layouts, so setup mode should be used before the first sync.
- Deleted old posts are detected only inside the configured refresh window.
- This project does not include deployment files yet; run it with your preferred process manager, such as `systemd`, Docker, or PM2.

## Development

Run tests:

```bash
npm test
```
