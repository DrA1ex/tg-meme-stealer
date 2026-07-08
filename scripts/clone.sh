#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

REPO_URL="https://github.com/DrA1ex/tg-meme-stealer"
DEFAULT_DB_PATH="data/posts.sqlite"
DEFAULT_SESSION_FILE="sessions/mtcute-user.session"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./scripts/clone.sh [--dry-run]

Interactive helper for creating a new tg-meme-stealer instance from an
already configured instance on the same Ubuntu server.

Options:
  --dry-run   Show what would be done, but do not write files or run pm2.
  -h, --help  Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  MAGENTA=$'\033[35m'
  RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; MAGENTA=""; RESET=""
fi

if [[ -t 1 ]]; then
  SYM_OK="✓"; SYM_WARN="!"; SYM_STEP="◆"; SYM_BOX_ON="☑"; SYM_BOX_OFF="☐"
else
  SYM_OK="OK"; SYM_WARN="WARN"; SYM_STEP="*"; SYM_BOX_ON="[x]"; SYM_BOX_OFF="[ ]"
fi

fail() { echo "${RED}Error:${RESET} $*" >&2; exit 1; }
warn() { echo "${YELLOW}${SYM_WARN}${RESET} $*" >&2; }
info() { echo "${BLUE}${SYM_STEP}${RESET} $*"; }
ok() { echo "${GREEN}${SYM_OK}${RESET} $*"; }

hr() {
  printf '%s────────────────────────────────────────────────────────────%s
' "$DIM" "$RESET"
}

banner() {
  echo
  hr
  printf '%s%s%s
' "$BOLD$CYAN" "tg-meme-stealer clone helper" "$RESET"
  printf '%s%s%s
' "$DIM" "Create a new parser instance from an existing working one." "$RESET"
  hr
}

section() {
  echo
  printf '%s%s %s%s
' "$BOLD$BLUE" "$SYM_STEP" "$*" "$RESET"
}

field() {
  local label="$1"
  local value="$2"
  printf '  %s%-24s%s %s
' "$DIM" "$label:" "$RESET" "$value"
}

ok_stderr() {
  echo "${GREEN}${SYM_OK}${RESET} $*" >&2
}

on_error() {
  local code=$?
  echo "${RED}Failed at line ${BASH_LINENO[0]} with exit code ${code}.${RESET}" >&2
  exit "$code"
}
trap on_error ERR

require_interactive() {
  [[ -t 0 ]] || fail "This script is interactive. Run it from a terminal."
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

expand_path() {
  local p="$1"
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#~/}" ;;
  esac
  realpath -m "$p"
}

strip_trailing_slash() {
  local p="$1"
  [[ "$p" == "/" ]] && { printf '/\n'; return; }
  printf '%s\n' "${p%/}"
}

prompt_text() {
  local label="$1"
  local default="${2:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -r -e -i "$default" -p "$label: " value
  else
    read -r -e -p "$label: " value
  fi
  printf '%s\n' "${value:-$default}"
}

prompt_required() {
  local label="$1"
  local default="${2:-}"
  local value=""
  while true; do
    value="$(prompt_text "$label" "$default")"
    [[ -n "$value" ]] && { printf '%s\n' "$value"; return; }
    warn "Value cannot be empty."
  done
}

prompt_path() {
  local label="$1"
  local default="${2:-}"
  local value
  value="$(prompt_required "$label" "$default")"
  strip_trailing_slash "$(expand_path "$value")"
}

trim_value() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s\n' "$value"
}

looks_like_bot_token() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]
}

prompt_bot_token() {
  local value=""
  while true; do
    value="$(prompt_required "New TELEGRAM_BOT_TOKEN (visible input)")"
    value="$(trim_value "$value")"
    if looks_like_bot_token "$value"; then
      ok_stderr "Bot token accepted: $(redact "$value")"
      printf '%s\n' "$value"
      return
    fi

    warn "This does not look like a standard Telegram bot token: $(redact "$value") (${#value} chars)"
    if prompt_yes_no "Enter TELEGRAM_BOT_TOKEN again?" y; then
      continue
    fi
    printf '%s\n' "$value"
    return
  done
}

prompt_yes_no() {
  local label="$1"
  local default="$2"
  local suffix answer
  case "$default" in
    y|Y) suffix="[Y/n]" ;;
    n|N) suffix="[y/N]" ;;
    *) fail "Internal error: prompt_yes_no default must be y or n" ;;
  esac
  while true; do
    read -r -p "$label $suffix " answer
    answer="${answer:-$default}"
    case "${answer,,}" in
      y|yes|д|да) return 0 ;;
      n|no|н|нет) return 1 ;;
      *) warn "Answer yes or no." ;;
    esac
  done
}

run() {
  printf '%s$' "$DIM"
  printf ' %q' "$@"
  printf '%s\n' "$RESET"
  if [[ "$DRY_RUN" == "0" ]]; then
    "$@"
  fi
}

run_in_dir() {
  local dir="$1"
  shift
  printf '%s$ cd %q &&' "$DIM" "$dir"
  printf ' %q' "$@"
  printf '%s\n' "$RESET"
  if [[ "$DRY_RUN" == "0" ]]; then
    (cd "$dir" && "$@")
  fi
}

write_file() {
  local path="$1"
  shift
  printf '%s$ write %q%s\n' "$DIM" "$path" "$RESET"
  if [[ "$DRY_RUN" == "0" ]]; then
    cat > "$path"
  else
    cat >/dev/null
  fi
}

read_env_value() {
  local file="$1"
  local key="$2"
  local fallback="${3:-}"
  [[ -f "$file" ]] || { printf '%s\n' "$fallback"; return; }
  local line
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || { printf '%s\n' "$fallback"; return; }
  printf '%s\n' "${line#*=}"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) print key "=" value
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

json_get() {
  local file="$1"
  local key_path="$2"
  local fallback="$3"
  [[ -f "$file" ]] || { printf '%s\n' "$fallback"; return; }
  node - "$file" "$key_path" "$fallback" <<'NODE'
const fs = require('fs');
const [file, keyPath, fallback] = process.argv.slice(2);
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = keyPath.split('.').reduce((obj, key) => obj == null ? undefined : obj[key], data);
  if (value === undefined || value === null || value === '') {
    console.log(fallback);
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value));
  } else {
    console.log(String(value));
  }
} catch {
  console.log(fallback);
}
NODE
}

patch_config_paths() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s$ patch %q database.path=%q telegram.sessionFile=%q%s\n' "$DIM" "$file" "$DEFAULT_DB_PATH" "$DEFAULT_SESSION_FILE" "$RESET"
    return 0
  fi
  DB_PATH="$DEFAULT_DB_PATH" SESSION_FILE="$DEFAULT_SESSION_FILE" node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.database ??= {};
config.database.path = process.env.DB_PATH;
config.telegram ??= {};
config.telegram.sessionFile = process.env.SESSION_FILE;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
NODE
}

redact() {
  local value="${1:-}"
  local len=${#value}
  if [[ -z "$value" ]]; then
    printf '(empty)'
  elif (( len <= 8 )); then
    printf '***'
  else
    printf '%s…%s' "${value:0:4}" "${value: -4}"
  fi
}

list_json_sections() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || Array.isArray(data) || typeof data !== 'object') process.exit(0);
  for (const key of Object.keys(data)) console.log(key);
} catch {
  process.exit(0);
}
NODE
}

join_by_comma() {
  local IFS=', '
  printf '%s' "$*"
}

choose_config_sections() {
  local -n out_ref="$1"
  shift
  local items=("$@")
  local selected=()
  local i choice token idx

  out_ref=()

  for ((i = 0; i < ${#items[@]}; i++)); do
    selected[$i]=1
  done

  if (( ${#items[@]} == 0 )); then
    warn "config.json exists, but no top-level sections were found."
    return 0
  fi

  while true; do
    echo
    printf '%s%s%s\n' "$BOLD" "config.json sections" "$RESET"
    printf '%s\n' "Toggle by number, use 'a' for all, 'n' for none, press Enter when done."
    for ((i = 0; i < ${#items[@]}; i++)); do
      if [[ "${selected[$i]}" == "1" ]]; then
        printf '  %s %2d. %s\n' "$SYM_BOX_ON" "$((i + 1))" "${items[$i]}"
      else
        printf '  %s %2d. %s\n' "$SYM_BOX_OFF" "$((i + 1))" "${items[$i]}"
      fi
    done
    if ! read -r -p "Toggle sections: " choice; then
      choice=""
      echo
    fi
    choice="$(trim_value "$choice")"
    [[ -z "$choice" ]] && break

    case "${choice,,}" in
      a|all|все)
        for ((i = 0; i < ${#items[@]}; i++)); do selected[$i]=1; done
        continue
        ;;
      n|none|ничего)
        for ((i = 0; i < ${#items[@]}; i++)); do selected[$i]=0; done
        continue
        ;;
    esac

    choice="${choice//,/ }"
    for token in $choice; do
      if [[ "$token" =~ ^[0-9]+$ ]]; then
        idx=$((token - 1))
        if (( idx >= 0 && idx < ${#items[@]} )); then
          if [[ "${selected[$idx]}" == "1" ]]; then
            selected[$idx]=0
          else
            selected[$idx]=1
          fi
        else
          warn "Section number is out of range: $token"
        fi
      else
        warn "Unsupported toggle value: $token"
      fi
    done
  done

  local count=0
  for ((i = 0; i < ${#items[@]}; i++)); do
    if [[ "${selected[$i]}" == "1" ]]; then
      out_ref+=("${items[$i]}")
      count=$((count + 1))
    fi
  done

  if (( count == 0 )); then
    warn "No config sections selected. A minimal config.json with local runtime paths will be created."
  fi
}

write_config_sections() {
  local source_file="$1"
  local target_file="$2"
  shift 2
  local keys=("$@")

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s$ write selected config sections to %q: %s%s\n' "$DIM" "$target_file" "$(join_by_comma "${keys[@]}")" "$RESET"
    return 0
  fi

  node - "$source_file" "$target_file" "${keys[@]}" <<'NODE'
const fs = require('fs');
const [sourceFile, targetFile, ...keys] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const output = {};
for (const key of keys) {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    output[key] = source[key];
  }
}
output.database ??= {};
output.database.path = 'data/posts.sqlite';
output.telegram ??= {};
output.telegram.sessionFile = 'sessions/mtcute-user.session';
fs.writeFileSync(targetFile, JSON.stringify(output, null, 2) + '\n');
NODE
}

sanitize_name() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/^-100//; s/^-//; s/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  [[ -n "$value" ]] || value="new"
  printf '%s\n' "$value"
}

pm2_name_exists() {
  local name="$1"
  has_cmd pm2 || return 1
  local tmp
  tmp="$(mktemp)"
  if ! pm2 jlist > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  set +e
  node -e '
    const fs = require("fs");
    const [file, name] = process.argv.slice(1);
    try {
      const apps = JSON.parse(fs.readFileSync(file, "utf8"));
      process.exit(apps.some(app => app?.name === name) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$tmp" "$name"
  local code=$?
  set -e
  rm -f "$tmp"
  return "$code"
}

validate_project_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -f "$dir/package.json" ]] || return 1
  [[ -f "$dir/index.js" ]] || return 1
  return 0
}

validate_empty_or_missing_dir() {
  local dir="$1"
  [[ ! -e "$dir" ]] && return 0
  [[ -d "$dir" ]] || return 1
  [[ -z "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

print_source_summary() {
  local source_path="$1"
  local source_env="$source_path/.env"
  local source_config="$source_path/config.json"
  local git_remote=""
  local git_branch=""

  if [[ -d "$source_path/.git" ]] && has_cmd git; then
    git_remote="$(git -C "$source_path" remote get-url origin 2>/dev/null || true)"
    git_branch="$(git -C "$source_path" branch --show-current 2>/dev/null || true)"
  fi

  section "Source instance summary"
  field "path" "$source_path"
  field "git remote" "${git_remote:-unknown}"
  field "git branch" "${git_branch:-unknown}"
  field ".env" "$([[ -f "$source_env" ]] && echo yes || echo no)"
  field "config.json" "$([[ -f "$source_config" ]] && echo yes || echo no)"
  field "node_modules" "$([[ -d "$source_path/node_modules" ]] && echo yes || echo no)"
  field "data/posts.sqlite" "$([[ -f "$source_path/data/posts.sqlite" ]] && echo yes || echo no)"
  field "session file" "$(json_get "$source_config" telegram.sessionFile "$DEFAULT_SESSION_FILE")"
  if [[ -f "$source_env" ]]; then
    field "TELEGRAM_API_ID" "$(read_env_value "$source_env" TELEGRAM_API_ID '(missing)')"
    field "TELEGRAM_API_HASH" "$(redact "$(read_env_value "$source_env" TELEGRAM_API_HASH '')")"
    field "source chat" "$(read_env_value "$source_env" TELEGRAM_SOURCE_CHAT_ID '(missing)')"
    field "admin id" "$(read_env_value "$source_env" TELEGRAM_ADMIN_ID '(missing)')"
    field "publish channel" "$(read_env_value "$source_env" TELEGRAM_PUBLISH_CHANNEL_ID '(missing)')"
    field "bot token" "$(redact "$(read_env_value "$source_env" TELEGRAM_BOT_TOKEN '')")"
  fi
}

write_ecosystem() {
  local path="$1"
  local name="$2"
  local cwd="$3"
  APP_NAME="$name" APP_CWD="$cwd" node <<'NODE' | write_file "$path"
const app = {
  apps: [
    {
      name: process.env.APP_NAME,
      script: 'index.js',
      args: 'daemon',
      cwd: process.env.APP_CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      time: true,
      kill_timeout: 15000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
process.stdout.write(JSON.stringify(app, null, 2) + '\n');
NODE
}

require_interactive
require_cmd bash
require_cmd node
require_cmd rsync
require_cmd realpath
require_cmd awk
require_cmd sed
if ! has_cmd pm2; then
  warn "pm2 is not installed or is not in PATH. The script can create the instance, but cannot start it."
fi

banner
cat <<EOF
Repository: $REPO_URL
EOF

current_default=""
if validate_project_dir "$(pwd)"; then
  current_default="$(pwd)"
elif [[ -d "/opt/tgmems" ]]; then
  current_default="/opt/tgmems"
elif [[ -d "/opt/tg-meme-stealer" ]]; then
  current_default="/opt/tg-meme-stealer"
fi

while true; do
  source_path="$(prompt_path "Existing configured instance path" "$current_default")"
  if validate_project_dir "$source_path"; then
    break
  fi
  warn "This does not look like a tg-meme-stealer instance: $source_path"
done

source_env="$source_path/.env"
source_config="$source_path/config.json"
[[ -f "$source_env" ]] || fail "Source .env was not found: $source_env"

print_source_summary "$source_path"

new_source_chat_id="$(prompt_required "New TELEGRAM_SOURCE_CHAT_ID")"
if [[ ! "$new_source_chat_id" =~ ^-?[0-9]+$ ]]; then
  warn "Telegram chat IDs are usually numeric, often like -1001234567890. You entered: $new_source_chat_id"
  prompt_yes_no "Continue with this value?" n || exit 1
fi

new_bot_token="$(prompt_bot_token)"

safe_id="$(sanitize_name "$new_source_chat_id")"
default_instance_name="tg-memes-$safe_id"
while true; do
  instance_name="$(prompt_required "New instance directory name" "$default_instance_name")"
  instance_name="$(sanitize_name "$instance_name")"
  [[ -n "$instance_name" ]] && break
done

default_parent="$(dirname "$source_path")"
while true; do
  target_parent="$(prompt_path "Parent directory for new instance" "$default_parent")"
  target_path="$target_parent/$instance_name"
  if validate_empty_or_missing_dir "$target_path"; then
    break
  fi
  warn "Target exists and is not empty: $target_path"
  prompt_yes_no "Choose another directory?" y || exit 1
done

while true; do
  pm2_name="$(prompt_required "PM2 app name" "$instance_name")"
  pm2_name="$(sanitize_name "$pm2_name")"
  if pm2_name_exists "$pm2_name"; then
    warn "PM2 app already exists: $pm2_name"
    default_instance_name="$pm2_name-new"
    continue
  fi
  break
done

source_session_rel="$(json_get "$source_config" telegram.sessionFile "$DEFAULT_SESSION_FILE")"
if [[ "$source_session_rel" = /* ]]; then
  source_session_abs="$source_session_rel"
else
  source_session_abs="$source_path/$source_session_rel"
fi

copy_session_default="n"
[[ -f "$source_session_abs" ]] && copy_session_default="y"
copy_session=0
if prompt_yes_no "Copy Telegram user session from source instance?" "$copy_session_default"; then
  copy_session=1
fi

copy_config=0
config_sections=()
selected_config_sections=()
if [[ -f "$source_path/config.json" ]] && prompt_yes_no "Copy config.json settings?" y; then
  copy_config=1
  mapfile -t config_sections < <(list_json_sections "$source_path/config.json")
  if (( ${#config_sections[@]} > 0 )); then
    choose_config_sections selected_config_sections "${config_sections[@]}"
  fi
fi

link_node_modules=0
install_deps=0
if [[ -d "$source_path/node_modules" ]]; then
  if prompt_yes_no "Symlink node_modules from source instance?" y; then
    link_node_modules=1
  else
    prompt_yes_no "Run npm install --omit=dev in the new instance?" y && install_deps=1
  fi
else
  warn "Source node_modules was not found."
  prompt_yes_no "Run npm install --omit=dev in the new instance?" y && install_deps=1
fi

start_pm2=0
save_pm2=0
if has_cmd pm2; then
  prompt_yes_no "Start the new instance with PM2 after creation?" y && start_pm2=1
  if [[ "$start_pm2" == "1" ]]; then
    prompt_yes_no "Run pm2 save after start?" y && save_pm2=1
  fi
fi

section "Plan"
field "source" "$source_path"
field "target" "$target_path"
field "new source chat" "$new_source_chat_id"
field "new bot token" "$(redact "$new_bot_token")"
field "publish channel" "$(read_env_value "$source_env" TELEGRAM_PUBLISH_CHANNEL_ID '(from source .env)')"
field "admin id" "$(read_env_value "$source_env" TELEGRAM_ADMIN_ID '(from source .env)')"
field "copy config.json" "$([[ "$copy_config" == "1" ]] && echo yes || echo no)"
if [[ "$copy_config" == "1" ]]; then
  field "config sections" "$(join_by_comma "${selected_config_sections[@]}")"
fi
field "database" "fresh $DEFAULT_DB_PATH"
field "copy session" "$([[ "$copy_session" == "1" ]] && echo yes || echo no)"
field "node_modules" "$([[ "$link_node_modules" == "1" ]] && echo symlink || ([[ "$install_deps" == "1" ]] && echo npm-install || echo skipped))"
field "ecosystem.json app" "$pm2_name"
field "pm2 start" "$([[ "$start_pm2" == "1" ]] && echo yes || echo no)"
field "pm2 save" "$([[ "$save_pm2" == "1" ]] && echo yes || echo no)"
echo

if [[ "$DRY_RUN" == "1" ]]; then
  warn "Dry run is enabled. No files will be changed."
fi

prompt_yes_no "Apply this plan?" y || exit 0

info "Creating target directory"
run mkdir -p "$target_parent"
run mkdir -p "$target_path"

info "Copying project files"
rsync_excludes=(
  --exclude 'node_modules'
  --exclude 'data'
  --exclude 'tmp'
  --exclude 'sessions'
  --exclude '.env'
  --exclude 'ecosystem.json'
  --exclude '.cache'
  --exclude 'coverage'
  --exclude 'dist'
  --exclude 'build'
  --exclude 'logs'
  --exclude '*.log'
)
rsync_excludes+=(--exclude 'config.json' --exclude 'config.json.old')
run rsync -a "${rsync_excludes[@]}" "$source_path/" "$target_path/"

info "Creating .env"
if [[ "$DRY_RUN" == "0" ]]; then
  cp "$source_env" "$target_path/.env"
  set_env_value "$target_path/.env" TELEGRAM_SOURCE_CHAT_ID "$new_source_chat_id"
  set_env_value "$target_path/.env" TELEGRAM_BOT_TOKEN "$new_bot_token"
else
  printf '%s$ cp %q %q%s\n' "$DIM" "$source_env" "$target_path/.env" "$RESET"
  printf '%s$ set TELEGRAM_SOURCE_CHAT_ID and TELEGRAM_BOT_TOKEN in %q%s\n' "$DIM" "$target_path/.env" "$RESET"
fi

info "Creating local runtime directories"
run mkdir -p "$target_path/data" "$target_path/tmp" "$target_path/sessions"

if [[ "$copy_config" == "1" ]]; then
  info "Writing selected config.json sections with local database and session paths"
  write_config_sections "$source_path/config.json" "$target_path/config.json" "${selected_config_sections[@]}"
fi

if [[ "$copy_session" == "1" ]]; then
  if [[ -f "$source_session_abs" ]]; then
    info "Copying Telegram user session"
    run mkdir -p "$target_path/$(dirname "$DEFAULT_SESSION_FILE")"
    run cp "$source_session_abs" "$target_path/$DEFAULT_SESSION_FILE"
    run chmod 600 "$target_path/$DEFAULT_SESSION_FILE"
  else
    warn "Session file was selected for copy, but was not found: $source_session_abs"
    warn "Run this later: cd '$target_path' && npm run session"
  fi
fi

if [[ "$link_node_modules" == "1" ]]; then
  info "Linking node_modules"
  run ln -s "$source_path/node_modules" "$target_path/node_modules"
elif [[ "$install_deps" == "1" ]]; then
  info "Installing dependencies"
  run_in_dir "$target_path" npm install --omit=dev
fi

info "Writing ecosystem.json"
write_ecosystem "$target_path/ecosystem.json" "$pm2_name" "$target_path"

if [[ "$start_pm2" == "1" ]]; then
  info "Starting PM2 app"
  run pm2 start "$target_path/ecosystem.json" --only "$pm2_name"
  if [[ "$save_pm2" == "1" ]]; then
    run pm2 save
  fi
fi

echo
ok "New instance was prepared: $target_path"
echo
echo "Next useful commands:"
echo "  cd $target_path"
if [[ "$copy_session" != "1" ]]; then
  echo "  npm run session        # authorize Telegram userbot if needed"
fi
echo "  npm run setup          # tune parser/publishing with the admin bot"
if [[ "$start_pm2" == "1" ]]; then
  echo "  pm2 logs $pm2_name"
else
  echo "  pm2 start ecosystem.json --only $pm2_name"
  echo "  pm2 save"
fi
echo
echo "After setup, use the admin bot commands /backfill, /stats, and /publish as usual."
