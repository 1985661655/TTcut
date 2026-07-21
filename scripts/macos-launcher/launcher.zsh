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
readonly MAX_LOG_BYTES=$((5 * 1024 * 1024))

if ! mkdir -p -- "$STATE_DIR" "$LOG_DIR"; then
  print -u2 -r -- '无法创建 TTcut 状态或日志目录。'
  exit 1
fi

if [[ -f "$LOG_FILE" ]] && (( $(stat -f '%z' -- "$LOG_FILE" 2>/dev/null) >= MAX_LOG_BYTES )); then
  mv -f -- "$LOG_FILE" "${LOG_FILE}.previous"
fi

log() {
  print -r -- "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

show_error() {
  local message=$1
  log "错误: $message"
  print -u2 -r -- "$message"

  [[ "${TTCUT_LAUNCHER_NO_UI:-}" == '1' ]] && return

  /usr/bin/osascript - "$message" "$LOG_FILE" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set response to button returned of (display dialog (item 1 of argv) buttons {"好", "查看日志"} default button "好")
  if response is "查看日志" then
    do shell script "/usr/bin/open " & quoted form of (item 2 of argv)
  end if
end run
APPLESCRIPT
}

is_live_pid() {
  local pid=$1 process_state
  kill -0 "$pid" 2>/dev/null || return 1
  process_state=$(/bin/ps -o stat= -p "$pid" 2>/dev/null)
  process_state=${process_state//[[:space:]]/}
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

log "环境摘要: launcher=${0:A} config=$CONFIG_FILE state=$STATE_DIR logs=$LOG_DIR PATH=$SAFE_PATH"

if [[ ! -r "$CONFIG_FILE" ]]; then
  show_error "无法读取启动器配置文件：$CONFIG_FILE"
  exit 1
fi

typeset -A CONFIG
typeset line key value
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line//$'\r'/}
  [[ -z "$line" || "${line[1]}" == '#' ]] && continue
  if [[ "$line" != *=* ]]; then
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

  if [[ "${value[1]}" == "'" && "${value[-1]}" == "'" ]] || [[ "${value[1]}" == '"' && "${value[-1]}" == '"' ]]; then
    value=${value[2,-2]}
  fi
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

if [[ -f "$PID_FILE" ]]; then
  typeset existing_pid
  existing_pid=$(<"$PID_FILE")
  if [[ "$existing_pid" == <-> ]] && is_live_pid "$existing_pid"; then
    log "TTcut 已经在运行 (PID $existing_pid)。"
    print -u2 -r -- 'TTcut 已经在运行'
    if [[ "${TTCUT_LAUNCHER_NO_UI:-}" != '1' ]]; then
      /usr/bin/osascript -e 'display notification "TTcut 已经在运行" with title "TTcut"' >/dev/null 2>&1
    fi
    exit 0
  fi
  rm -f -- "$PID_FILE"
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
typeset npm_pid=$!
print -r -- "$npm_pid" > "$PID_FILE"
log "已启动 TTcut npm 进程 (PID $npm_pid)。"

typeset startup_wait="${TTCUT_LAUNCHER_STARTUP_WAIT:-1}"
if [[ ! "$startup_wait" =~ '^[0-9]+([.][0-9]+)?$' ]]; then
  startup_wait=1
fi
/bin/sleep "$startup_wait"

if ! is_live_pid "$npm_pid"; then
  rm -f -- "$PID_FILE"
  show_error 'TTcut 启动失败，请查看日志。'
  exit 1
fi

log "TTcut 启动检查通过 (PID $npm_pid)。"
exit 0
