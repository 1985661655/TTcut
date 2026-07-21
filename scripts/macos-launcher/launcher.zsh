#!/bin/zsh

emulate -L zsh
setopt pipefail

export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

readonly SAFE_PATH="$PATH"
readonly LAUNCHER_DIR="${0:A:h}"
readonly CONFIG_FILE="${TTCUT_LAUNCHER_CONFIG:-${LAUNCHER_DIR:h}/Resources/launcher.conf}"
readonly STATE_DIR="${TTCUT_LAUNCHER_STATE_DIR:-${HOME}/Library/Application Support/TTcut}"
readonly LOG_DIR="${TTCUT_LAUNCHER_LOG_DIR:-${HOME}/Library/Logs/TTcut}"
readonly LOG_FILE="${LOG_DIR}/launcher.log"
readonly PID_FILE="${STATE_DIR}/launcher.pid"
readonly LOCK_DIR="${STATE_DIR}/launcher.lock"
readonly LOCK_OWNER_FILE="${LOCK_DIR}/owner"
readonly OSASCRIPT_PATH="${TTCUT_LAUNCHER_OSASCRIPT:-/usr/bin/osascript}"
readonly MAX_LOG_BYTES=$((5 * 1024 * 1024))

typeset LOCK_HELD=0
typeset CHILD_PID=''
typeset PID_TEMP_FILE=''

log() {
  [[ -d "$LOG_DIR" ]] || return 0
  { print -r -- "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; } 2>/dev/null || return 0
}

show_error() {
  local message=$1
  log "错误: $message"
  print -u2 -r -- "$message"

  [[ "${TTCUT_LAUNCHER_NO_UI:-}" == '1' ]] && return

  "$OSASCRIPT_PATH" - "$message" "$LOG_FILE" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set response to button returned of (display dialog (item 1 of argv) buttons {"好", "查看日志"} default button "好")
  if response is "查看日志" then
    try
      tell application "Finder" to open (POSIX file (item 2 of argv))
    end try
  end if
end run
APPLESCRIPT
}

show_running() {
  local message=$1
  log "$message"
  print -u2 -r -- "$message"
  [[ "${TTCUT_LAUNCHER_NO_UI:-}" == '1' ]] && return
  "$OSASCRIPT_PATH" -e 'display notification "TTcut 已经在运行" with title "TTcut"' >/dev/null 2>&1
}

is_live_pid() {
  local pid=$1 process_state
  kill -0 "$pid" 2>/dev/null || return 1
  process_state=$(/bin/ps -o stat= -p "$pid" 2>/dev/null)
  process_state=${process_state//[[:space:]]/}
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

process_fingerprint() {
  /bin/ps -o lstart= -p "$1" 2>/dev/null
}

pid_matches_fingerprint() {
  local pid=$1 expected=$2 actual
  [[ "$pid" == <-> && -n "$expected" ]] || return 1
  is_live_pid "$pid" || return 1
  actual=$(process_fingerprint "$pid")
  [[ -n "$actual" && "$actual" == "$expected" ]]
}

release_lock() {
  [[ "$LOCK_HELD" == 1 ]] || return 0
  if [[ -r "$LOCK_OWNER_FILE" ]]; then
    local owner_pid owner_fingerprint
    IFS=$'\t' read -r owner_pid owner_fingerprint < "$LOCK_OWNER_FILE"
    if [[ "$owner_pid" != "$$" ]]; then
      LOCK_HELD=0
      return 0
    fi
  fi
  rm -f -- "$LOCK_OWNER_FILE" 2>/dev/null
  rmdir -- "$LOCK_DIR" 2>/dev/null
  LOCK_HELD=0
}

terminate_child() {
  local pid=$1 attempt
  [[ "$pid" == <-> ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for attempt in {1..10}; do
    is_live_pid "$pid" || break
    /bin/sleep 0.1
  done
  is_live_pid "$pid" && kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  [[ -n "$PID_TEMP_FILE" ]] && rm -f -- "$PID_TEMP_FILE" 2>/dev/null
  [[ -n "$CHILD_PID" ]] && terminate_child "$CHILD_PID"
  release_lock
}

trap cleanup EXIT
trap 'exit 1' INT TERM HUP

clear_stale_lock() {
  local stale_lock="${LOCK_DIR}.stale.$$"
  if [[ -d "$stale_lock" ]]; then
    rm -f -- "$stale_lock/owner" 2>/dev/null
    if ! rmdir -- "$stale_lock" 2>/dev/null; then
      show_error '无法清理过期的 TTcut 启动锁。'
      return 1
    fi
  fi
  mv -- "$LOCK_DIR" "$stale_lock" 2>/dev/null || return 2
  rm -f -- "$stale_lock/owner" 2>/dev/null
  if ! rmdir -- "$stale_lock" 2>/dev/null; then
    show_error '无法清理过期的 TTcut 启动锁。'
    return 1
  fi
  return 0
}

acquire_lock() {
  local attempt=0 cleanup_status owner_check owner_pid='' owner_fingerprint='' self_fingerprint
  self_fingerprint=$(process_fingerprint "$$")

  while (( attempt < 3 )); do
    if mkdir -- "$LOCK_DIR" 2>/dev/null; then
      if [[ -z "$self_fingerprint" ]] || ! print -r -- "$$"$'\t'"$self_fingerprint" > "$LOCK_OWNER_FILE"; then
        rm -f -- "$LOCK_OWNER_FILE" 2>/dev/null
        rmdir -- "$LOCK_DIR" 2>/dev/null
        show_error '无法写入 TTcut 启动锁。'
        return 1
      fi
      LOCK_HELD=1
      return 0
    fi

    owner_pid=''
    owner_fingerprint=''
    for owner_check in {1..5}; do
      if [[ -r "$LOCK_OWNER_FILE" ]]; then
        IFS=$'\t' read -r owner_pid owner_fingerprint < "$LOCK_OWNER_FILE"
        break
      fi
      /bin/sleep 0.02
    done
    if pid_matches_fingerprint "$owner_pid" "$owner_fingerprint"; then
      show_running 'TTcut 正在启动'
      return 2
    fi

    clear_stale_lock
    cleanup_status=$?
    if (( cleanup_status == 1 )); then
      return 1
    fi
    (( attempt++ ))
    (( cleanup_status == 2 )) && /bin/sleep 0.02
  done

  show_running 'TTcut 正在启动'
  return 2
}

prepare_pid_path() {
  local probe_file="${PID_FILE}.probe.$$"
  if [[ -d "$PID_FILE" || ( -e "$PID_FILE" && ! -f "$PID_FILE" ) || ! -w "$STATE_DIR" ]]; then
    return 1
  fi
  if ! : > "$probe_file" 2>/dev/null; then
    return 1
  fi
  rm -f -- "$probe_file" 2>/dev/null
  return 0
}

write_pid_file() {
  local pid=$1 fingerprint=$2 expected_record observed_record temp_name
  expected_record="$pid"$'\t'"$fingerprint"
  PID_TEMP_FILE="${PID_FILE}.tmp.$$"
  temp_name="${PID_TEMP_FILE:t}"
  if ! print -r -- "$expected_record" > "$PID_TEMP_FILE" 2>/dev/null; then
    return 1
  fi
  if ! mv -f -- "$PID_TEMP_FILE" "$PID_FILE" 2>/dev/null; then
    return 1
  fi
  if [[ -d "$PID_FILE" ]]; then
    rm -f -- "$PID_FILE/$temp_name" 2>/dev/null
    return 1
  fi
  [[ -f "$PID_FILE" ]] || return 1
  observed_record=$(<"$PID_FILE")
  [[ "$observed_record" == "$expected_record" ]] || return 1
  PID_TEMP_FILE=''
  return 0
}

if ! mkdir -p -- "$STATE_DIR" "$LOG_DIR"; then
  show_error '无法创建 TTcut 状态或日志目录。'
  exit 1
fi

if [[ -f "$LOG_FILE" ]] && (( $(stat -f '%z' -- "$LOG_FILE" 2>/dev/null) > MAX_LOG_BYTES )); then
  mv -f -- "$LOG_FILE" "${LOG_FILE}.previous"
fi

log "环境摘要: launcher=${0:A} config=$CONFIG_FILE state=$STATE_DIR logs=$LOG_DIR PATH=$SAFE_PATH"

if [[ ! -r "$CONFIG_FILE" ]]; then
  show_error "无法读取启动器配置文件：$CONFIG_FILE"
  exit 1
fi

# launcher.conf is one raw KEY=value record per line. Values are never evaluated.
typeset -A CONFIG
typeset line key value
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line//$'\r'/}
  [[ -z "$line" || "${line[1]}" == '#' ]] && continue
  if [[ "$line" == *$'\0'* || "$line" != *=* ]]; then
    show_error '启动器配置格式无效。'
    exit 1
  fi

  key=${line%%=*}
  value=${line#*=}
  case "$key" in
    PROJECT_DIR|NPM_PATH|PYTHON_PATH|WEIGHTS_PATH|FFMPEG_PATH|FFPROBE_PATH) ;;
    *)
      show_error "启动器配置包含不支持的变量：$key"
      exit 1
      ;;
  esac
  CONFIG[$key]=$value
done < "$CONFIG_FILE"

for key in PROJECT_DIR NPM_PATH PYTHON_PATH WEIGHTS_PATH FFMPEG_PATH FFPROBE_PATH; do
  if [[ -z "${CONFIG[$key]:-}" ]]; then
    show_error "启动器配置缺少变量：$key"
    exit 1
  fi
done

readonly PROJECT_DIR="${CONFIG[PROJECT_DIR]}"
readonly NPM_PATH="${CONFIG[NPM_PATH]}"
readonly PYTHON_PATH="${CONFIG[PYTHON_PATH]}"
readonly WEIGHTS_PATH="${CONFIG[WEIGHTS_PATH]}"
readonly FFMPEG_PATH="${CONFIG[FFMPEG_PATH]}"
readonly FFPROBE_PATH="${CONFIG[FFPROBE_PATH]}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  show_error "项目不存在：$PROJECT_DIR"
  exit 1
fi
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  show_error "缺少 package.json：$PROJECT_DIR/package.json"
  exit 1
fi
if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  show_error "缺少 node_modules：$PROJECT_DIR/node_modules"
  exit 1
fi
if [[ ! -x "$NPM_PATH" ]]; then
  show_error "找不到或无法执行 npm：$NPM_PATH"
  exit 1
fi
if [[ ! -x "$PYTHON_PATH" ]]; then
  show_error "找不到或无法执行 Python：$PYTHON_PATH"
  exit 1
fi
if [[ ! -f "$WEIGHTS_PATH" ]]; then
  show_error "找不到 TrackNet 权重：$WEIGHTS_PATH"
  exit 1
fi
if [[ ! -x "$FFMPEG_PATH" ]]; then
  show_error "找不到或无法执行 FFmpeg：$FFMPEG_PATH"
  exit 1
fi
if [[ ! -x "$FFPROBE_PATH" ]]; then
  show_error "找不到或无法执行 ffprobe：$FFPROBE_PATH"
  exit 1
fi

acquire_lock
typeset lock_status=$?
if (( lock_status == 2 )); then
  exit 0
fi
if (( lock_status != 0 )); then
  exit 1
fi

if ! prepare_pid_path; then
  show_error '无法写入 TTcut 进程状态。'
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  typeset existing_pid existing_fingerprint
  IFS=$'\t' read -r existing_pid existing_fingerprint < "$PID_FILE"
  if pid_matches_fingerprint "$existing_pid" "$existing_fingerprint"; then
    show_running 'TTcut 已经在运行'
    exit 0
  fi
  if ! rm -f -- "$PID_FILE"; then
    show_error '无法清理过期的 TTcut 进程状态。'
    exit 1
  fi
  log '已删除过期的 launcher.pid。'
fi

if ! cd -- "$PROJECT_DIR"; then
  show_error "无法进入项目目录：$PROJECT_DIR"
  exit 1
fi

export TTCUT_PYTHON="$PYTHON_PATH"
export TTCUT_TRACKNET_WEIGHTS="$WEIGHTS_PATH"
export TTCUT_FFMPEG="$FFMPEG_PATH"
export TTCUT_FFPROBE="$FFPROBE_PATH"

nohup "$NPM_PATH" start </dev/null >> "$LOG_FILE" 2>&1 &
CHILD_PID=$!
typeset child_fingerprint
child_fingerprint=$(process_fingerprint "$CHILD_PID")
if [[ -z "$child_fingerprint" ]]; then
  terminate_child "$CHILD_PID"
  CHILD_PID=''
  show_error 'TTcut 启动失败，请查看日志。'
  exit 1
fi
if ! write_pid_file "$CHILD_PID" "$child_fingerprint"; then
  terminate_child "$CHILD_PID"
  CHILD_PID=''
  rm -f -- "$PID_FILE" "$PID_TEMP_FILE" 2>/dev/null
  PID_TEMP_FILE=''
  show_error '无法写入 TTcut 进程状态。'
  exit 1
fi
log "已启动 TTcut npm 进程 (PID $CHILD_PID)。"

typeset startup_wait="${TTCUT_LAUNCHER_STARTUP_WAIT:-1}"
if [[ ! "$startup_wait" =~ '^[0-9]+([.][0-9]+)?$' ]]; then
  startup_wait=1
fi
/bin/sleep "$startup_wait"

if ! pid_matches_fingerprint "$CHILD_PID" "$child_fingerprint"; then
  terminate_child "$CHILD_PID"
  CHILD_PID=''
  rm -f -- "$PID_FILE" 2>/dev/null
  show_error 'TTcut 启动失败，请查看日志。'
  exit 1
fi

log "TTcut 启动检查通过 (PID $CHILD_PID)。"
CHILD_PID=''
release_lock
exit 0
