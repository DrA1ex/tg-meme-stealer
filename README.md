# tg-meme-stealer

`tg-memes` reads posts from a Telegram group or channel through a regular user account, stores parsed post statistics in SQLite, and publishes ranked selections through a Telegram bot.

It is intended for communities where a regular bot cannot be added to the source chat. The user account is used only for reading source content; the bot is used for administration and publishing.

## Features

- Reads text posts, photos, videos, and albums.
- Refreshes recent posts so changing reaction counts affect later selections.
- Supports configurable filters, author extraction, reaction extraction, ranking sources, windows, thresholds, and schedules.
- Publishes durable queued selections and resumes interrupted jobs.
- Detects recently deleted source posts with a safety threshold.
- Provides QR login and an admin-only setup assistant.
- Supports manual sync, backfill, publication, diagnostics, grouped error reports, and graceful restart.
- Uses SQLite locally and can use Redis to coordinate Telegram rate limits across processes.

## Requirements

- Node.js 20 or newer.
- A Telegram API ID and API hash from <https://my.telegram.org>.
- A regular Telegram account that can read the source chat.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Permission for the bot to post in the target channel.

## Quick start

Clone the repository and install dependencies:

```bash
git clone https://github.com/DrA1ex/tg-meme-stealer
cd tg-meme-stealer
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

Fill in the Telegram credentials and IDs in `.env`. Create `config.json` only when defaults need to be overridden:

```bash
cp config.default.json config.json
```

The complete configuration reference is [`config.default.json`](./config.default.json). Keep `config.json` limited to local overrides.

Create the user session:

```bash
npm run session
```

Open Telegram on the phone and scan the QR code from:

```text
Settings → Devices → Link Desktop Device
```

Start setup mode:

```bash
npm run setup
```

Open a private chat with the configured admin bot and run:

```text
/setup
```

Use the button-driven assistant to configure parsing and publishing, test source messages, preview output, validate schedules, and save the draft. After saving, restart the process so the new runtime configuration is applied.

Start the daemon:

```bash
npm start
```

Build the initial history window:

```text
/backfill
```

Then inspect the database and run a manual publication:

```text
/stats
/publish weekly_best
```

## Common admin commands

```text
/stats
/sync
/sync --force
/backfill
/backfill 90
/publish <selection-key>
/publish <selection-key> --force
/publication <id>
/logs
/setup
/restart
```

`/sync --force` overrides only the deleted-post reconciliation safety threshold. It does not ignore Telegram errors or incomplete history scans.

`/logs` sends all pending grouped ERROR events to the admin and clears only the snapshot that was delivered successfully. The same report is sent automatically at the configured daily digest time.

## Running with PM2

An example process file is provided in [`ecosystem.example.json`](./ecosystem.example.json):

```bash
cp ecosystem.example.json ecosystem.config.json
pm2 start ecosystem.config.json
pm2 save
```

The `/restart` command requests a graceful process restart. The process manager must be configured to bring the daemon back up.

## Redis

Redis is optional for one process and recommended when multiple processes share the same Telegram credentials or rate-limit group.

Connection values are configured through `.env`; rate-limit behavior is configured in [`config.default.json`](./config.default.json). In required mode, Telegram operations stop instead of silently using independent local limits when Redis is unavailable.

Real-Redis integration tests can be run with:

```bash
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

## Data and local files

By default the application creates local runtime data such as:

- the mtcute user session;
- the SQLite database and WAL files;
- temporary downloaded media;
- local `.env` and `config.json` overrides.

These files are excluded by `.gitignore` and must not be included in shared archives.

## Testing

Run the complete test suite:

```bash
npm test
```

Run the Redis-focused integration suite:

```bash
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

## Documentation

- [Quick start](openwiki/quickstart.md)
- [Configuration and operations](openwiki/configuration-and-operations.md)
- [Setup assistant](openwiki/setup-assistant.md)
- [Data and publishing](openwiki/data-and-publishing.md)
- [Sync and reaction verification](openwiki/sync-and-reactions.md)
- [Architecture](openwiki/architecture.md)
- [Testing](openwiki/testing.md)
- [Source map](openwiki/source-map.md)
