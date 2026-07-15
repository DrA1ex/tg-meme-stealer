# Configuration and operations

## Configuration contract

`src/config/index.js` loads defaults from `config.default.json`, deep-merges optional local `config.json`, applies environment-backed Telegram/Redis values, migrates legacy publish shape where needed, then validates the result before startup.

Keep credentials and chat identifiers out of committed files and documentation. `.env.example` shows placeholder variable names; the required Telegram inputs are API ID/hash, source chat, admin ID, target channel, and bot token. Redis coordination is optional (`RATE_LIMIT_REDIS_ENABLED`, `RATE_LIMIT_REDIS_URL`).

### Merge behavior that affects changes

- Normal nested objects deep-merge.
- `publish.template` is replaced as a whole—an override owns the full template array.
- `publish.sources` merges by `key`.
- Validation enforces known keys/types, valid IANA timezone/locale, distinct source and target chats, unique sources/templates, valid source expressions, schedule shapes, and bounded timing/retry/lease values.

Read loader/validation before adding any config key; `config.default.json` alone is not the full contract.

## Operator runbook

### Bootstrap

1. Install dependencies with `npm install`.
2. Create local `.env` from its example and populate required credentials privately.
3. Create a user session via `npm run session` and QR login.
4. Run `npm run setup`, message the bot privately as the configured admin, and use `/setup` to test/parser/publish configuration.
5. Restart into `npm start` after a save—setup writes future config and does not hot-reload a daemon.
6. Use `/backfill`, then `/stats`; inspect a manual `/publish <selection>` before relying on schedules.

### Admin commands

Commands are accepted only from `telegram.adminId` in a private chat (`src/telegram/adminCommands.js`):

| Command | Purpose |
| --- | --- |
| `/stats` | Database and publication summary |
| `/jobs` | Active/recent work view |
| `/publications`, `/publication <id>` | Publication list/detail for operator inspection |
| `/sync [--force]` | Recent scan; force bypasses deletion-safety threshold only after investigation |
| `/backfill [days]` | Historical fill/refresh |
| `/publish [--force] <selection…>` | Create/drain publication requests; force intentionally bypasses normal duplicate/gate behavior |
| `/setup` | Open the draft configuration assistant |
| `/restart` | Request service-manager restart after saved configuration changes |

`/sync`/`/backfill` avoid waiting behind unrelated work: a busy response is safer than an opaque queued interactive request.

## Operational safety and recovery

- **Failed sync pauses publishing:** `SyncWorker` retries with bounded exponential backoff. Exhaustion pauses automatic publication and notifies the admin; a successful sync clears the pause. Investigate scan errors before forcing publication.
- **Deletion reconciliation:** `maxMissingRatio` blocks potentially broad source-post deletion. Use `/sync --force` only after confirming the observed history window is valid.
- **Publication recovery:** the worker periodically revisits durable, retry-ready, unleased/expired requests. Inspect publication details before handling `uncertain` work; automatic resend is intentionally blocked to avoid duplicates.
- **Graceful stop:** signal handling stops timers, rejects queued work, aborts waits, drains polling/active work within `shutdown.timeoutMs`, then closes resources. Allow the process manager to send normal termination signals rather than killing an active process abruptly.
- **Retention/media:** `sync.retentionDays` only prunes source `posts`; publication audit state remains. Temporary downloaded media is stored under `sync.mediaDir` and cleaned after attempts.

## Rate limits and deployment topology

MTProto scans use per-operation jitter/throttle plus FLOOD_WAIT handling. Bot sends use local global/per-chat limits and honor Bot API `retry_after`. Optional Redis can coordinate reservations/penalties across processes, with local fallback if unavailable (`src/telegram/{throttle,botRateLimiter,redisRateLimitStore}.js`).

The included `scripts/clone.sh` supports a PM2-oriented model of **one instance per source chat**. It makes a fresh local database/runtime directories and may reuse a user session or dependencies; it deliberately does not copy the source SQLite DB (`scripts/README.md`). Use its dry run before applying changes. Its visible bot-token prompt means operators should avoid shared terminals or recorded sessions.

Do not infer active/active multi-host support: polling lock files are local; SQLite leases require a safely shared database file to coordinate; independent databases do not deduplicate publication across hosts.

## CI and deploy boundary

`.github/workflows/test.yml` runs `npm ci` and `npm test` on Node 20 with Redis 7 for tests. `.github/workflows/trigger-deploy.yml` dispatches only successful push-triggered `test` workflow runs on `main` to a private deployment repository, passing the tested SHA.

This repository does **not** document the private deployment repo’s migration, backup, restart, health-check, or rollback behavior. Avoid claiming deployment guarantees beyond this handoff. OpenWiki refresh is a separate scheduled/manual workflow that opens a docs update PR.

## When changing operations/config

- Config schema/default/merge/validation: `test/config.test.js`, `test/setupConfig.test.js`.
- Admin command behavior and lifecycle: `test/publisherLifecycle.test.js`, `test/app.test.js` plus affected publisher/sync tests.
- Rate limits/Redis behavior: `test/throttle.test.js`, `test/botRateLimiter.test.js`, `test/redisRateLimitStore.test.js`, `test/rateLimitUtils.test.js`.
- Deployment workflow edits: ensure `trigger-deploy.yml` continues to reference the exact CI workflow name (`test`) and dispatches only the workflow-run SHA.
