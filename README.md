# tg-memes

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
git clone https://github.com/your-name/tg-memes.git
cd tg-memes
npm install
```

Create `.env`:

```bash
cp .env.example .env
```

Fill in:

```dotenv
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SOURCE_CHAT_ID=-1001234567890
TELEGRAM_TARGET_USER_ID=123456789
TELEGRAM_ADMIN_ID=123456789
TELEGRAM_PUBLISH_CHANNEL_ID=-1009876543210
TELEGRAM_BOT_TOKEN=123456:bot_token
```

`TELEGRAM_TARGET_USER_ID` is required when `sync.source.mode` is `"user"`. If you want to scan matching posts from every sender, set `sync.source.mode` to `"all"` in `config.json`.

## Configuration

Runtime options live in `config.default.json`. To override them, create a local `config.json` in the project root:

```bash
cp config.default.json config.json
```

`config.json` is deep-merged over `config.default.json`, so it can contain only the values you want to change. Keep secrets and Telegram IDs in `.env`.

Common options:

```json
{
  "sync": {
    "initialScanMonths": 2,
    "refreshRecentDays": 7,
    "source": {
      "mode": "user"
    }
  },
  "publish": {
    "monthTopLimit": 10,
    "weekTopLimit": 10,
    "freshTopLimit": 5,
    "freshWindowHours": 24,
    "dryRun": false
  },
  "schedule": {
    "timezone": "Europe/Moscow",
    "syncIntervalHours": 24,
    "publish": {
      "fresh": { "enabled": true, "time": "10:00" },
      "week": { "enabled": true, "time": "10:10" },
      "month": { "enabled": true, "time": "10:20" }
    }
  }
}
```

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
/preview 100
/done
```

Useful setup commands:

```text
/mode user
/mode all
/setfilter {"source":"message","transform":"hasContent"}
/addfilter {"source":"message","path":"message","regex":"#meme","transform":"bool"}
/setauthor {"source":"message","path":"message","regex":"(?:^|\\n)By\\s+(.+?)(?:\\n|$)","group":1}
/setlikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👍\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/setdislikes {"source":"message","path":"replyMarkup.rows[].buttons[].text","regex":"👎\\s*([\\d\\s,.]+[km]?)","group":1,"transform":"count","aggregate":"sum"}
/settemplate postCaption {{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\n\n{{text}}
/settemplate title.week Weekly community picks
/settemplate unknownAuthor anonymous
```

`/test N` reads the latest `N` source messages, applies the draft parser, and does not write anything to the database. `/preview N` shows an example post that would be selected for the weekly top. `/done` saves the draft into `config.json`. If `config.json` already exists, it is copied to `config.json.old` first.

### Recommended Setup Workflow

1. Start setup mode:

```bash
npm run setup
```

2. Open a private chat with your bot as `TELEGRAM_ADMIN_ID` and start a draft:

```text
/setup
```

3. Choose who to scan:

```text
/mode user
```

or:

```text
/mode all
```

4. Start with a broad filter:

```text
/setfilter {"source":"message","transform":"hasContent"}
```

5. Test recent messages:

```text
/test 30
```

6. Add stricter filters or parser rules until the matched posts look correct.

7. Preview the post that would win the weekly selection:

```text
/preview 100
```

8. Save the final config:

```text
/done
```

9. Run a sync with the saved config:

```bash
npm run sync
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
- `bool`: true for non-empty strings, non-zero numbers, and `true`.

Filter examples:

```text
/setfilter {"source":"message","transform":"hasContent"}
/setfilter {"source":"message","transform":"hasMedia"}
/setfilter {"source":"message","transform":"isPhoto"}
/setfilter {"source":"message","transform":"isVideo"}
/setfilter {"source":"message","path":"text","regex":"#meme","transform":"bool"}
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

Published captions and admin stats can be customized in `templates`.

Example:

```json
{
  "templates": {
    "publish": {
      "selectionTitles": {
        "week": "Best posts from the last week"
      },
      "postCaption": "{{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\n\n{{text}}",
      "unknownAuthor": "unknown",
      "maxTextLength": 700
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

Setup mode can edit templates with:

```text
/settemplate <key> <value>
```

Supported keys:

- `postCaption`
- `unknownAuthor`
- `maxTextLength`
- `title.month`
- `title.week`
- `title.fresh`
- `stats.summary`
- `stats.topPost`

Examples:

```text
/settemplate postCaption #{{position}} {{author}} | 👍 {{likes}} 👎 {{dislikes}}\n\n{{text}}
/settemplate title.month Best posts this month
/settemplate maxTextLength 500
/settemplate stats.topPost Top month post: #{{messageId}}, score {{score}}
```

Run `/preview N` after changing templates to see the final rendered post. Setup preview does not upload media; it prints the number of media items and their source message ids.

## Running

Run one sync:

```bash
npm run sync
```

Run one publish cycle:

```bash
npm run publish
```

Run sync and publish once:

```bash
npm run once
```

Run the daemon:

```bash
npm start
```

The daemon starts the admin bot, runs an initial sync if configured, schedules sync by interval, and schedules each publication type by local time.

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

Media is not stored permanently. The database stores Telegram media references in `data.media`; media is downloaded to `sync.mediaDir` only when publishing.

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
