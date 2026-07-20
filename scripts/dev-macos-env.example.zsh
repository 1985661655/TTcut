# Source this file from the TTcut repository root after creating a Python venv.
# Adjust TTCUT_TRACKNET_WEIGHTS to the downloaded TrackNet_best.pt location.

export TTCUT_PYTHON="${TTCUT_PYTHON:-$PWD/.venv/bin/python}"
export TTCUT_TRACKNET_WEIGHTS="${TTCUT_TRACKNET_WEIGHTS:-$HOME/Downloads/TrackNet_best.pt}"
export TTCUT_FFMPEG="${TTCUT_FFMPEG:-/opt/homebrew/bin/ffmpeg}"
export TTCUT_FFPROBE="${TTCUT_FFPROBE:-/opt/homebrew/bin/ffprobe}"

echo "TTCUT_PYTHON=$TTCUT_PYTHON"
echo "TTCUT_TRACKNET_WEIGHTS=$TTCUT_TRACKNET_WEIGHTS"
echo "TTCUT_FFMPEG=$TTCUT_FFMPEG"
echo "TTCUT_FFPROBE=$TTCUT_FFPROBE"
