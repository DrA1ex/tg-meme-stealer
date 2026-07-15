# tg-memes: OpenWiki quickstart

`tg-memes` is a Node.js Telegram rankings service for communities where a regular bot cannot be added to the source chat. An **MTProto user client** reads source history; configurable parsing turns messages into stored posts; a **Telegraf admin bot** manages setup and publishes selected posts to a target channel.

This wiki is an engineering map of the local codebase at the inspected HEAD. It covers the implementation and checked-in operational guidance—not live Telegram state, local secrets, or the private deployment repository.

## Product flow

```text
Source Telegram chat
  └─ MTProto scanner → parser/filter rules → SQLite posts
                                           └─ rolling selection → durable publication request
                                                                  └─ bot API → target channel

Admin (private chat only) ── commands and setup assistant ──► sync / backfill / publish / configuration
```

The system exists to collect changing reaction counts from source messages, rank eligible content over configurable windows, and publish reproducible selections without blindly repeating partially completed Telegram sends.

## Start here

| Need | Read |
| --- | --- |
| Understand processes, scheduling, shutdown, and concurrency | [Architecture](architecture.md) |
| Change scanning, parsing, selection, SQLite, or publication delivery | [Data and publishing](data-and-publishing.md) |
| Change runtime settings, operate the bot, deploy or recover | [Configuration and operations](configuration-and-operations.md) |
| Change the bot-driven configuration experience | [Setup assistant](setup-assistant.md) |
| Find code ownership and extension entrypoints | [Source map](source-map.md) |
| Select and run relevant checks | [Testing](testing.md) |

## Key entrypoints

- `index.js` — chooses `session`, `setup`, or `daemon` mode and handles process signals.
- `src/runtime/app.js` — assembles all runtime dependencies and owns bounded shutdown.
- `src/telegram/scanner.js` — paginates source history, parses posts, and safely reconciles deletions.
- `src/telegram/publisher.js` — launches the admin bot, creates durable publication requests, and drains them.
- `src/database/postRepository.js` and `src/database/migrations.js` — SQLite access, schema evolution, selection queries, and delivery state.
- `src/config/index.js` — loads defaults and local overrides, applies environment-backed values, and validates the final configuration.

## Local command surface

```bash
npm install
npm run session  # QR-login and save the MTProto user session
npm run setup    # admin bot + configuration assistant; no scheduler
npm start        # admin bot + scheduler + workers
npm test         # Node built-in test suite
```

Node 20 or newer is required (`package.json`). Follow the user-facing launch sequence in `README.md`: configure placeholders in `.env`, create the MTProto session, tune parser/publishing settings through `/setup`, start the daemon, then backfill and inspect stats. Do not place credentials in documentation or commit local runtime files.

## Important current behavior

- Source posts are keyed by `(chat_id, message_id)` and are refreshed because reactions may change. Recent deletion reconciliation runs only after an authoritative scan and is guarded by `sync.maxMissingRatio` (`src/telegram/scanner.js`).
- Publication is a two-stage workflow: selection snapshots become SQLite requests first; a worker later claims a leased request and sends its header/posts. This separates schedule/admin intent from delivery and enables restart recovery.
- Delivery state is deliberately conservative. A request or post left in an indeterminate `sending` state becomes `uncertain` rather than being automatically retried and potentially duplicated (`src/telegram/publisher.js`, `src/database/postRepository.js`).
- One in-process `JobGate` serializes sync, retention, and worker activity. SQLite leases coordinate publication claims for processes sharing the same database; the bot polling lock is a local filesystem lock (`src/runtime/jobGate.js`, `src/telegram/botPollingLock.js`).
- Setup saves `config.json` for a future process start; it does not mutate the running daemon configuration. Restart after a save.

## Recent design direction

Recent commits explain why the code has several reliability layers:

- **SQLite driver hardening:** `7b66dfe` replaced the vulnerable `sqlite`/`sqlite3` chain with a pinned `better-sqlite3` adapter (`src/database/sqliteDatabase.js`).
- **Recovery-focused refactor:** `89a92b6` added versioned migrations, publication progress/error fields, polling lifecycle controls, deletion safety, and broad reliability tests.
- **Bounded shutdown:** `5ba007f` centralized cancellation, bot draining, queued-job rejection, and deadline-bounded resource closing.
- **Test-gated deploy dispatch:** current CI runs `npm test`; only a successful push workflow on `main` dispatches the tested SHA to the private deployment repository.

## Change checklist

1. Start at the owning entrypoint above, then follow the linked domain page.
2. Treat `config.default.json` plus `src/config/index.js` as the configuration contract; arrays and source/template merge behavior are intentional.
3. Preserve the publication state machine and lease checks when changing delivery; avoid turning uncertain delivery into an implicit resend.
4. Run focused tests first, then `npm test` for cross-cutting runtime, parser, repository, scheduler, or publisher work.
5. Check `git status` before handoff. The initial inspection found untracked OpenWiki automation/instruction files; they are user-authored control/automation artifacts, not generated documentation to rewrite.

## Backlog

- **Production deployment/rollback:** `.github/workflows/trigger-deploy.yml` only dispatches to `DrA1ex/tg-meme-stealer-deploy`; its rollout, health-check, backup, and rollback procedures are outside this repository.
- **Uncertain-publication remediation:** `src/telegram/adminCommands.js` supports inspection, but a dedicated resolve/retry/cancel policy for `uncertain` jobs was not identified in inspected sources.
