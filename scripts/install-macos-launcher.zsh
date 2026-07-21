#!/bin/zsh

emulate -L zsh
setopt errexit nounset pipefail

PROJECT_DIR="${TTCUT_PROJECT_DIR:-/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port}"
APP_DESTINATION="${TTCUT_APP_DESTINATION:-/Applications/TTcut.app}"
PYTHON_PATH="${TTCUT_PYTHON_PATH:-${PROJECT_DIR}/.venv312/bin/python}"
WEIGHTS_PATH="${TTCUT_WEIGHTS_PATH:-/Users/xkkx6/Downloads/TrackNet_best.pt}"
FFMPEG_PATH="${TTCUT_FFMPEG_PATH:-/opt/homebrew/bin/ffmpeg}"
FFPROBE_PATH="${TTCUT_FFPROBE_PATH:-/opt/homebrew/bin/ffprobe}"
NPM_PATH="${TTCUT_NPM_PATH:-/opt/homebrew/bin/npm}"

readonly SCRIPT_DIR="${0:A:h}"
readonly LAUNCHER_SOURCE="${SCRIPT_DIR}/macos-launcher/launcher.zsh"
readonly ICON_SOURCE="${SCRIPT_DIR:h}/resources/macos/ttcut-launcher-icon.png"
readonly DESTINATION_PARENT="${APP_DESTINATION:h}"
readonly DESTINATION_NAME="${APP_DESTINATION:t}"
readonly TEMP_PREFIX="${DESTINATION_PARENT}/.${DESTINATION_NAME}.ttcut-installer."

typeset STAGING_DIR=''
typeset BACKUP_DIR=''
typeset PRESERVE_BACKUP=0

fail() {
  print -u2 -r -- "错误：$1"
  exit 1
}

is_owned_temp_path() {
  local path=$1
  [[ -n "$path" && -n "$DESTINATION_PARENT" && "$DESTINATION_PARENT" != '/' && -n "$DESTINATION_NAME" ]] || return 1
  case "$path" in
    ("$TEMP_PREFIX"*) return 0 ;;
    (*) return 1 ;;
  esac
}

remove_owned_directory() {
  local path=$1
  is_owned_temp_path "$path" || return 0
  [[ -e "$path" || -L "$path" ]] || return 0
  /bin/rm -rf "$path"
}

restore_backup_if_needed() {
  [[ -n "$BACKUP_DIR" && "$PRESERVE_BACKUP" -eq 0 && ! -e "$APP_DESTINATION" ]] || return 0
  if /bin/mv "$BACKUP_DIR" "$APP_DESTINATION"; then
    BACKUP_DIR=''
  else
    PRESERVE_BACKUP=1
    print -u2 -r -- "错误：无法恢复原有 TTcut.app：$BACKUP_DIR"
  fi
}

cleanup() {
  local exit_status=$?
  restore_backup_if_needed || true
  remove_owned_directory "$STAGING_DIR" || true
  if [[ "$PRESERVE_BACKUP" -eq 0 ]]; then
    remove_owned_directory "$BACKUP_DIR" || true
  fi
  return "$exit_status"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

reject_unsafe_value() {
  local name=$1 value=$2
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\0'* ]]; then
    fail "配置路径无效（不能为空且不能包含换行、回车或 NUL）：$name"
  fi
}

for config_name in PROJECT_DIR APP_DESTINATION PYTHON_PATH WEIGHTS_PATH FFMPEG_PATH FFPROBE_PATH NPM_PATH; do
  reject_unsafe_value "$config_name" "${(P)config_name}"
done

[[ -f "$LAUNCHER_SOURCE" && -r "$LAUNCHER_SOURCE" ]] || fail "启动器源文件不存在或无法读取：$LAUNCHER_SOURCE"
[[ -f "$ICON_SOURCE" && -r "$ICON_SOURCE" ]] || fail "图标源文件不存在或无法读取：$ICON_SOURCE"

icon_info=$(sips -g format -g pixelWidth -g pixelHeight "$ICON_SOURCE" 2>/dev/null) || fail "无法读取图标文件：$ICON_SOURCE"
[[ "${icon_info:l}" == *'format: png'* && "$icon_info" == *'pixelWidth: 1024'* && "$icon_info" == *'pixelHeight: 1024'* ]] || fail "图标必须是 1024x1024 PNG：$ICON_SOURCE"

[[ -d "$PROJECT_DIR" ]] || fail "项目目录不存在：$PROJECT_DIR"
[[ -f "$PROJECT_DIR/package.json" ]] || fail "项目缺少 package.json：$PROJECT_DIR/package.json"
[[ -d "$PROJECT_DIR/node_modules" ]] || fail "项目缺少 node_modules：$PROJECT_DIR/node_modules"
[[ -x "$NPM_PATH" ]] || fail "找不到或无法执行 npm：$NPM_PATH"
[[ -x "$PYTHON_PATH" ]] || fail "找不到或无法执行 Python：$PYTHON_PATH"
[[ -f "$WEIGHTS_PATH" ]] || fail "找不到 TrackNet 权重：$WEIGHTS_PATH"
[[ -x "$FFMPEG_PATH" ]] || fail "找不到或无法执行 FFmpeg：$FFMPEG_PATH"
[[ -x "$FFPROBE_PATH" ]] || fail "找不到或无法执行 ffprobe：$FFPROBE_PATH"
[[ -d "$DESTINATION_PARENT" && -w "$DESTINATION_PARENT" ]] || fail "目标目录不存在或不可写：$DESTINATION_PARENT"

STAGING_DIR=$(/usr/bin/mktemp -d "${TEMP_PREFIX}staging.XXXXXXXX") || fail "无法在目标目录创建构建临时目录：$DESTINATION_PARENT"
/bin/mkdir -p "$STAGING_DIR/Contents/MacOS" "$STAGING_DIR/Contents/Resources"

/bin/cp "$LAUNCHER_SOURCE" "$STAGING_DIR/Contents/MacOS/TTcutLauncher"
/bin/chmod 755 "$STAGING_DIR/Contents/MacOS/TTcutLauncher"

{
  print -r -- "PROJECT_DIR=$PROJECT_DIR"
  print -r -- "NPM_PATH=$NPM_PATH"
  print -r -- "PYTHON_PATH=$PYTHON_PATH"
  print -r -- "WEIGHTS_PATH=$WEIGHTS_PATH"
  print -r -- "FFMPEG_PATH=$FFMPEG_PATH"
  print -r -- "FFPROBE_PATH=$FFPROBE_PATH"
} > "$STAGING_DIR/Contents/Resources/launcher.conf"

cat > "$STAGING_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>TTcutLauncher</string>
  <key>CFBundleDisplayName</key>
  <string>TTcut</string>
  <key>CFBundleName</key>
  <string>TTcut</string>
  <key>CFBundleIdentifier</key>
  <string>com.weiye.ttcut.local-launcher</string>
  <key>CFBundleIconFile</key>
  <string>TTcut</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

ICONSET_DIR="$STAGING_DIR/TTcut.iconset"
/bin/mkdir -p "$ICONSET_DIR"
typeset -a icon_sizes=(
  '16 icon_16x16.png'
  '32 icon_16x16@2x.png'
  '32 icon_32x32.png'
  '64 icon_32x32@2x.png'
  '128 icon_128x128.png'
  '256 icon_128x128@2x.png'
  '256 icon_256x256.png'
  '512 icon_256x256@2x.png'
  '512 icon_512x512.png'
  '1024 icon_512x512@2x.png'
)
for icon_size in "${icon_sizes[@]}"; do
  size=${icon_size%% *}
  icon_name=${icon_size#* }
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET_DIR/$icon_name" >/dev/null || fail "无法生成应用图标：$icon_name"
done
iconutil -c icns "$ICONSET_DIR" -o "$STAGING_DIR/Contents/Resources/TTcut.icns" || fail '无法转换 TTcut 应用图标。'
/bin/rm -rf "$ICONSET_DIR"

[[ -x "$STAGING_DIR/Contents/MacOS/TTcutLauncher" ]] || fail '应用启动器构建验证失败。'
[[ -f "$STAGING_DIR/Contents/Resources/launcher.conf" ]] || fail '应用配置构建验证失败。'
[[ -s "$STAGING_DIR/Contents/Resources/TTcut.icns" ]] || fail '应用图标构建验证失败。'
/usr/bin/plutil -lint "$STAGING_DIR/Contents/Info.plist" >/dev/null || fail '应用 Info.plist 验证失败。'

if [[ -e "$APP_DESTINATION" || -L "$APP_DESTINATION" ]]; then
  BACKUP_DIR=$(/usr/bin/mktemp -d "${TEMP_PREFIX}backup.XXXXXXXX") || fail "无法创建原有应用备份：$DESTINATION_PARENT"
  /bin/rmdir "$BACKUP_DIR" || fail "无法准备原有应用备份：$BACKUP_DIR"
  if ! /bin/mv "$APP_DESTINATION" "$BACKUP_DIR"; then
    BACKUP_DIR=''
    fail "无法备份现有应用：$APP_DESTINATION"
  fi
fi

if ! /bin/mv "$STAGING_DIR" "$APP_DESTINATION"; then
  print -u2 -r -- "错误：无法安装 TTcut.app：$APP_DESTINATION"
  restore_backup_if_needed
  exit 1
fi
STAGING_DIR=''

if [[ -n "$BACKUP_DIR" ]]; then
  if ! remove_owned_directory "$BACKUP_DIR"; then
    print -u2 -r -- "警告：已安装新 TTcut.app，但无法删除旧备份：$BACKUP_DIR"
  fi
  BACKUP_DIR=''
fi

print -r -- "已安装 TTcut.app：$APP_DESTINATION"
print -r -- '现在可在 Finder 中双击 TTcut.app 启动。'
print -r -- "日志路径：${HOME}/Library/Logs/TTcut/launcher.log"
