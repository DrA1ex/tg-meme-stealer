# scripts/clone.sh

`clone.sh` is an interactive helper for creating additional `tg-meme-stealer` instances on the same server.

The intended setup is one running instance per source Telegram chat. Each instance has its own `.env`, bot token, PM2 app, session/runtime directory and SQLite database, while several instances can publish into the same target channel.

Use this script when you already have one configured and working instance on the server and want to add another source chat without repeating the setup by hand.

## What the script does

The script asks for an existing working instance, uses it as a template, and prepares a new instance next to it or in another parent directory.

During the run it:

1. validates the existing `tg-meme-stealer` directory;
2. shows a short summary of the source instance;
3. asks for the new `TELEGRAM_SOURCE_CHAT_ID`;
4. asks for the new `TELEGRAM_BOT_TOKEN`;
5. asks for the new instance directory name and parent directory;
6. copies the project files from the source instance;
7. creates a fresh `.env` for the new instance;
8. creates fresh `data/`, `tmp/`, and `sessions/` directories;
9. optionally copies `config.json`;
10. optionally copies the Telegram user session;
11. optionally symlinks `node_modules` from the source instance;
12. writes a new `ecosystem.json` for PM2;
13. optionally starts the new PM2 app;
14. optionally runs `pm2 save`.

The script does not copy the old SQLite database. The new instance starts with a fresh `data/posts.sqlite` database.

## Expected repository layout

The script is meant to live inside the project repository:

```text
tg-meme-stealer/
  scripts/
    clone.sh
    README.md
```

Run it from the project root:

```bash
./scripts/clone.sh
```

A dry run is available:

```bash
./scripts/clone.sh --dry-run
```

`--dry-run` prints the planned filesystem and PM2 actions, but does not create files, copy data, install dependencies, or start PM2.

## Server requirements

Install basic system dependencies:

```bash
sudo apt update
sudo apt install -y bash coreutils rsync git
```

The project itself requires Node.js 20 or newer.

PM2 is optional while preparing files, but required if you want `clone.sh` to start the new instance automatically:

```bash
npm install -g pm2
```

Run the script as the same Linux user that owns the existing instance and PM2 process. Do not use `sudo` unless the existing app is also intentionally managed by root.

## Before running

Make sure you have:

1. one existing `tg-meme-stealer` instance that already works;
2. a new Telegram source chat ID, usually in the form `-100...`;
3. a new Telegram bot token for the new instance;
4. access rights for the Telegram user session if the new source chat is private;
5. PM2 available if you want the script to start the instance immediately.

The source instance should normally contain:

```text
.env
config.json
index.js
package.json
node_modules/
sessions/mtcute-user.session
```

The database file may exist in the source instance, but it will not be copied.

## Typical flow

Assume the current working instance is located at:

```text
/opt/tgmems
```

Start the helper:

```bash
./scripts/clone.sh
```

Example answers:

```text
Existing configured instance path: /opt/tgmems
New TELEGRAM_SOURCE_CHAT_ID: -1001234567890
New TELEGRAM_BOT_TOKEN: 123456789:AA...
New instance directory name: tg-memes-some-channel
Parent directory for new instance: /opt
PM2 app name: tg-memes-some-channel
Copy Telegram user session from source instance? [Y/n] y
Copy config.json parser/publishing settings? [Y/n] y
Symlink node_modules from source instance? [Y/n] y
Start the new instance with PM2 after creation? [Y/n] y
Run pm2 save after start? [Y/n] y
Apply this plan? [Y/n] y
```

The result will be a new directory:

```text
/opt/tg-memes-some-channel
```

with approximately this structure:

```text
/opt/tg-memes-some-channel/
  .env
  config.json
  ecosystem.json
  data/
  tmp/
  sessions/
    mtcute-user.session
  node_modules -> /opt/tgmems/node_modules
```

## What is copied and what is not

Copied from the source instance:

```text
project source files
.git directory / current checkout state
package.json and package-lock.json
config.json, if confirmed
Telegram session, if confirmed
```

Created fresh:

```text
.env
data/
tmp/
sessions/
ecosystem.json
```

Not copied:

```text
node_modules/        # symlinked or installed separately
data/                # old database/runtime data
tmp/
sessions/           # except the selected mtcute session file
ecosystem.json       # regenerated per PM2 app
logs/
*.log
coverage/
dist/
build/
.cache/
```

## `.env` behavior

The script copies `.env` from the source instance and replaces only:

```text
TELEGRAM_SOURCE_CHAT_ID
TELEGRAM_BOT_TOKEN
```

Other values are reused from the source instance, including:

```text
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_PUBLISH_CHANNEL_ID
TELEGRAM_ADMIN_ID
```

This matches the intended setup: a new parser/bot process for a new source chat, but the same Telegram API credentials, same admin, and same publish channel.

## `config.json` behavior

If you choose to copy `config.json`, the script patches runtime paths so the new instance cannot accidentally write into the old instance:

```text
database.path = "data/posts.sqlite"
telegram.sessionFile = "sessions/mtcute-user.session"
```

Parser and publishing settings are otherwise reused from the source instance. After creation, run the setup flow if the new source chat needs different parsing rules.

## Telegram session behavior

If the source instance has a Telegram user session, the script offers to copy it.

Copying the session is convenient when the same Telegram user account has access to all source channels. If the copied session does not work for the new source chat, delete the copied session and authorize again inside the new instance:

```bash
cd /opt/tg-memes-some-channel
npm run session
```

## Dependency behavior

If the source instance has `node_modules`, the script offers to create a symlink:

```text
new-instance/node_modules -> source-instance/node_modules
```

This avoids reinstalling dependencies for every source chat. It is suitable when all instances run on the same server and use the same checkout/dependency versions.

If you do not want shared dependencies, decline the symlink and allow the script to run:

```bash
npm install --omit=dev
```

## PM2 behavior

The script generates a new `ecosystem.json` instead of copying the old one. Each PM2 app needs its own `name` and absolute `cwd`.

The generated app runs:

```bash
node index.js daemon
```

After creation, useful PM2 commands are:

```bash
pm2 logs <app-name>
pm2 status
pm2 save
```

If you did not start PM2 during the script run:

```bash
cd /opt/tg-memes-some-channel
pm2 start ecosystem.json --only tg-memes-some-channel
pm2 save
```

## After creation

Open the new instance:

```bash
cd /opt/tg-memes-some-channel
```

If needed, authorize the Telegram userbot:

```bash
npm run session
```

Tune parser and publishing settings:

```bash
npm run setup
```

Then use the admin bot commands as usual:

```text
/setup
/backfill
/stats
/publish weekly_best
```

## Path autocompletion

Path prompts use Bash readline, so `Tab` completion works in normal interactive terminals.

For example, when the script asks:

```text
Existing configured instance path:
```

you can type `/opt/tg` and press `Tab`.

## Safety notes

Use `--dry-run` before the first real run if you want to verify the plan.

The script prints a final plan before making changes and asks for confirmation.

The script does not delete or modify the source instance.

The script does not copy the old database.

The script may copy a Telegram session only after confirmation. Treat copied session files as secrets.

The script may create a shared `node_modules` symlink. Updating dependencies in the source instance can affect all linked instances.