# IINA Clip Recorder

Mark a range on the IINA media timeline and export it as MP4, GIF, or both.

[Download the latest release](https://github.com/fivepool/iina-clip-recorder/releases/latest) · [Author](https://maksimarkatov.com)

IINA Clip Recorder is tested with IINA 1.4.4 build 168 on macOS. Other IINA
versions may work, but have not been audited.

## Features

- Start and finish a clip selection with one configurable shortcut (`⌘R` by
  default).
- Export MP4, GIF, or both formats from the same selected range.
- MP4 uses H.264 VideoToolbox with a controlled libx264 fallback and optional
  AAC audio.
- GIF uses a two-pass `palettegen` → `paletteuse` workflow.
- 1080p MP4 and 720p GIF presets preserve aspect ratio and never upscale
  smaller sources.
- In-player REC, encoding, confirmation, and result overlays.
- Reveal the saved clip in Finder directly from the result card.
- Large-export confirmation, free-space checks, collision-safe filenames, and
  cleanup of temporary files.

## Requirements

- macOS.
- IINA 1.4.4 build 168 is the tested version.
- An external FFmpeg executable. FFmpeg is not bundled with the plugin.

Node.js and pnpm are required only for development and building from source.

### Install FFmpeg

The easiest option is [Homebrew](https://brew.sh):

```sh
brew install ffmpeg
ffmpeg -version
```

For MP4 export, the FFmpeg build must provide `h264_videotoolbox` or
`libx264`. GIF export requires the `palettegen` and `paletteuse` filters.

The plugin searches for FFmpeg in this order:

1. The custom path configured in the plugin settings.
2. `ffmpeg` available through IINA's `PATH`.
3. `/opt/homebrew/bin/ffmpeg`.
4. `/usr/local/bin/ffmpeg`.
5. `/opt/local/bin/ffmpeg`.

If automatic detection fails, enter the absolute path to the executable in
the plugin settings. FFmpeg is never installed automatically.

## Installation

### From GitHub

1. Open `IINA → Settings… → Plugins`.
2. Choose the option to install a plugin from GitHub.
3. Enter `https://github.com/fivepool/iina-clip-recorder`.
4. Enable the plugin if IINA asks for confirmation.

Installing from GitHub enables IINA's update checks for future releases.

### From a release package

1. Download `iina-clip-recorder-<version>.iinaplgz` from the
   [latest GitHub release](https://github.com/fivepool/iina-clip-recorder/releases/latest).
2. Open the package with IINA, or select it through
   `IINA → Settings… → Plugins → Install Package…`.
3. Enable the plugin if requested.
4. Open its settings and confirm the output directory and formats.

## Usage

1. Open a local SDR video file.
2. Press `⌘R` to mark the start of the clip.
3. Seek or play to a later position.
4. Press `⌘R` again to mark the end and start exporting.
5. Use `Reveal in Finder` from the result card when the export finishes.

The selection follows the media timeline. Pausing or changing playback speed
does not alter the selected timestamps.

If the second marker is earlier than the first, the export is rejected and the
selection is reset. At natural end-of-file, an active selection finishes at the
media duration automatically.

## Settings

| Setting | Default | Options |
| --- | --- | --- |
| Shortcut | `⌘R` | One modified key combination |
| Output formats | MP4 | MP4, GIF, or both |
| MP4 resolution | 1080p | 1080p fit or Full Resolution |
| MP4 audio | Included | Optional video-only export |
| GIF resolution | 720p | 720p fit or Full Resolution |
| GIF frame rate | 12 fps | 12 fps or Match Source |
| Output directory | `~/Movies/IINA Clips` | `~/…` or an absolute path |
| FFmpeg path | Auto-detect | Empty or an absolute executable path |

Export settings are captured when the first marker is placed. Reload plugins
or restart IINA after changing the shortcut.

## Output formats

### MP4

- H.264/yuv420p in an `.mp4` container.
- VideoToolbox targets approximately 7 Mbit/s.
- The libx264 fallback uses CRF 20, so its bitrate and file size vary.
- The selected embedded audio track is encoded as AAC 192 kbit/s unless audio
  is disabled.
- Source timestamps are preserved without forcing 25, 30, or 60 fps.
- Subtitles, data streams, and attachments are not copied.

### GIF

- No audio.
- Two-pass palette generation and application.
- `12 fps` or source-timestamp mode.
- GIF timing is limited to 1/100-second increments by the format.
- Full-resolution and source-rate GIFs can be much larger and slower than MP4.

When both formats are enabled, MP4 and GIF are encoded sequentially. One format
can still succeed if the other fails.

## Large exports

The plugin checks free space in both IINA's temporary directory and the chosen
output destination. It asks for confirmation when:

- the selected range is at least five minutes;
- the estimated combined output is at least 512 MB; or
- free space is close to the internal planning reserve.

Size estimates are approximate, especially for GIF and the libx264 fallback.
The plugin never changes the selected resolution, frame rate, palette, or
output formats automatically.

## Supported scope

Supported:

- Local SDR video files with a finite duration.
- Embedded video and audio streams.
- MP4 and GIF output.

Not supported:

- Network URLs, HTTP/HLS/DASH streams, cookies, headers, or DRM.
- Screen capture.
- External video tracks or external audio tracks.
- HDR export or HDR-to-SDR tone mapping. Known BT.2020, PQ, HLG, and ST 2084
  sources are rejected before selection starts.

See [Known limitations](docs/known-limitations.md) for lifecycle, storage, VFR,
GIF, and metadata details.

## Troubleshooting

### FFmpeg was not found

Run `ffmpeg -version`, then set the executable's absolute path in the plugin
settings if it is not in a standard location.

### The shortcut does not work

Choose a different shortcut if `⌘R` conflicts with an IINA or macOS binding.
You can always use
`Plugins → IINA Clip Recorder → Start / Stop Clip Selection`.

### An export keeps running after the player closes

IINA 1.4.4 does not expose process cancellation to plugins. Once FFmpeg has
started, the immutable export may finish in the background even if the player
window closes.

### A GIF is unexpectedly large

GIF compression depends strongly on motion, grain, noise, dithering, frame
rate, and dimensions. Use the 720p/12 fps defaults for more predictable files.

## Development

Requirements:

- Node.js 20 or newer.
- pnpm 11.7.0.
- IINA installed in `/Applications` for packaging and development linking.
- FFmpeg and ffprobe for media integration tests.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run pack
```

`pnpm run pack` writes the installable archive to
`build/iina-clip-recorder-<version>.iinaplgz` and requires IINA's
`iina-plugin` CLI. Set `IINA_PLUGIN_CLI` if IINA is installed elsewhere.

Development link:

```sh
pnpm run link
pnpm run unlink
```

Additional media integration suite:

```sh
pnpm fixtures:generate
pnpm fixtures:verify
pnpm test:media
```

Set `FFMPEG` and `FFPROBE` to use non-standard executable paths. Generated test
videos are written to `test-media/generated/` and are not committed.

## Documentation

- [Architecture](docs/architecture.md)
- [Known limitations](docs/known-limitations.md)
- [Implementation plan](docs/implementation-plan.md)
- [Manual test plan](docs/manual-test-plan.md)

## License

This project is currently published without an open-source license
(`UNLICENSED`). FFmpeg is a separate, externally installed project and is not
included in this repository or the plugin package.

---

Created by [Maksim Arkatov](https://maksimarkatov.com).
