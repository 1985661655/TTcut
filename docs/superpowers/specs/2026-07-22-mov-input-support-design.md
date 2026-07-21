# MOV Input Support Design

## Goal

Allow TTcut to select, drop, preview, analyze, reopen from history, and export a
single `.mov` video in addition to `.mp4`. This specifically covers iPhone MOV
recordings, including the HEVC Main 10/HDR sample files available on the target
Mac.

MOV input must not add an unconditional conversion step. Every export remains an
H.264/AAC MP4 named from the source stem:

- `match.mp4` -> `match_ALcut.mp4`
- `IMG_7818.MOV` -> `IMG_7818_ALcut.mp4`
- when that name exists, use `IMG_7818_ALcut_2.mp4`, then `_3`, and so on

Existing source files and earlier exports are never overwritten.

## Supported Inputs

The application accepts one regular, non-empty file whose extension is `.mp4`
or `.mov`, compared case-insensitively. Other extensions remain unsupported.
This allowlist applies consistently at every trust boundary:

- Electron file picker and dropped-file validation
- FFprobe metadata inspection
- TypeScript-to-Python analysis requests
- Python video path validation and OpenCV decoding
- history reopening

Extension acceptance does not imply codec acceptance. FFprobe and OpenCV still
verify that the selected file contains a readable video stream with valid
dimensions, duration, and frame rate. Unsupported or damaged codecs use the
existing unreadable-video error path, with wording that refers to a video rather
than only an MP4 file.

## Application Flow

The renderer labels the input as "MP4 或 MOV" in Chinese and "MP4 or MOV" in
English. The native picker exposes both extensions in one video filter. Drag and
drop follows the same validation as the picker.

The media protocol registers MP4 sources as `video/mp4` and MOV sources as
`video/quicktime`, so Electron receives the correct content type for calibration
and rally previews. Exported files remain `video/mp4`.

FFprobe reports the source container as `mp4` or `mov` based on the accepted file
extension. The shared metadata contract permits both values. Analysis continues
to replace the worker's minimal metadata with FFprobe metadata before saving
history, preserving the actual source container.

## Export Behavior

Output naming is based on the source stem but always uses `.mp4`. The existing
safe collision loop remains in place with the new `_ALcut` suffix.

The existing stream-copy optimization may be attempted when its timing and codec
conditions allow. Output validation still requires H.264 video and AAC audio, so
an incompatible MOV stream automatically falls back to the existing accurate
re-encode path. No source-wide preprocessing or temporary proxy is added.

## Error Handling

- A non-MP4/MOV path returns `INVALID_INPUT` before probing or analysis.
- A missing, empty, damaged, or undecodable MP4/MOV follows the existing input or
  unreadable-video errors.
- Export failures retain partial-file cleanup and never overwrite an existing
  output.
- Existing MP4 workflows and saved history remain compatible.

## Testing

Tests are added before production changes and cover:

- case-insensitive MP4/MOV acceptance and rejection of unrelated extensions
- Python request and video-path acceptance for MOV
- source container metadata for both extensions
- MOV MIME type selection for local preview
- fixed `_ALcut.mp4` output naming and collision suffixes
- updated Chinese and English input labels

After unit and Python suites pass, the installed Mac application is refreshed and
smoke-tested with `/Volumes/futures/table tennis/IMG_7818.MOV`. The smoke test
must reach the calibration screen, render a video frame, and confirm FFprobe and
OpenCV can read the real HEVC/HDR source. Full model analysis is outside this
format-boundary test because the same decoded-frame pipeline is already covered
by the existing analysis tests.
