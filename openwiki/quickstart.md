# OpenWiki Quickstart

## Repository Overview

`tg-memes` is a Node.js Telegram rankings bot. It logs into Telegram as a regular user through mtcute, scans a source chat that a normal bot might not be able to join, stores parsed posts in SQLite, and publishes ranked selections to a target channel through a Telegraf bot.

The main product flow is:

1. A userbot reads source chat history.
2. Parser rules decide which Telegram messages become posts and extract author, text, reaction counts, and media references.
3. `PostRepository` persists posts and publication jobs in SQLite.
4. Scheduler or admin commands create publication requests from configured rolling windows.
5. A publication worker sends headers and rich posts to the configured target channel.

Important source entrypoints:

- `index.js` selects `session`, `setup`, or `daemon` mode.
- `src/runtime/app.js` wires the repository, Telegram user client, scanner, setup assistant, publisher, workers, and shared job gate.
- `src/telegram/scanner.js` scans and backfills source history.
- `src/telegram/publisher.js` owns admin bot commands and publication request processing.
- `src/telegram/setupAssistant.js` registers setup commands and composes setup flow modules.
- `src/database/postRepository.js` owns the SQLite schema and query layer.

## Start Here

- [Architecture](architecture.md): runtime composition, modes, scheduler, and job serialization.
- [Data and publishing](data-and-publishing.md): parser, scanner, SQLite schema, selections, publication requests, media sending, and resumability.
- [Setup assistant](setup-assistant.md): button-driven setup mode, draft config sessions, diagnostics, and save behavior.
- [Configuration and operations](configuration-and-operations.md): environment, config shape, schedules, first-send gates, retention, and admin commands.
- [Testing](testing.md): test suite map and what to run when changing each area.

## Local Commands

The project is an ESM Node.js app. `package.json` defines:

```bash
npm install
npm run session
npm run setup
npm start
npm test
```

`npm run session` creates the mtcute user session. `npm run setup` starts the admin bot in setup mode. `npm start` starts the daemon mode with the admin bot, scheduler, sync worker, retention worker, and publication worker.

## First-Run Flow

The README is the user-facing install guide. The implementation expects this sequence:

1. Create `.env` from `.env.example` and provide Telegram API credentials, source chat, admin user, publish channel, and bot token.
2. Optionally copy `config.default.json` to `config.json` for local overrides.
3. Run `npm run session` and scan the QR code to create `sessions/mtcute-user.session`.
4. Run `npm run setup`, open a private chat with the bot as `TELEGRAM_ADMIN_ID`, then use `/setup`.
5. Save parser and publishing settings from setup mode.
6. Run `npm start`.
7. Use admin commands such as `/backfill`, `/stats`, and `/publish weekly_best`.

Setup and daemon mode both launch the admin bot, so `/stats`, `/sync`, `/backfill`, `/publish`, and `/setup` behavior depends on which runtime is currently active.

## What To Watch

- Secrets and Telegram IDs come from `.env`; do not document or read live secret values.
- `config.json` is local override state. Setup mode writes it and backs up the previous file to `config.json.old`.
- Publication templates are globally keyed by `publish.template[].key`; duplicate keys are invalid even across different sources.
- Publication jobs are durable in SQLite and block duplicate scheduled/normal publications while status is `created`, `running`, or `published`.
- `publish.firstSendAt` and template-level `firstSendAt` gate normal scheduled/manual publication, but forced manual publication can bypass the gate.
- Sync, backfill, retention, and publication worker operations share an in-memory `JobGate`; overlapping requests may queue or be skipped depending on source and key.

