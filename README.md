# IINA Clip Recorder

Export a selected part of a video from IINA as MP4, GIF, or both.

[Releases](https://github.com/fivepool/iina-clip-recorder/releases) · [Maksim Arkatov](https://maksimarkatov.com)

Tested with IINA 1.4.4 build 168 on macOS.

## Features

- One shortcut to mark the start and end of a clip (`⌘R` by default).
- MP4, GIF, or both from the same range.
- 1080p MP4 and 720p GIF presets without upscaling.
- Optional audio for MP4.
- In-player status and Reveal in Finder.

## Requirements

- macOS and IINA.
- [FFmpeg](https://ffmpeg.org/) 6.1 or newer, installed separately.

With Homebrew:

```sh
brew install ffmpeg
```

The plugin detects common Homebrew locations automatically. A custom FFmpeg
path can also be set in the plugin preferences.

## Installation

Download the `.iinaplgz` file from [Releases](https://github.com/fivepool/iina-clip-recorder/releases),
then open it with IINA or use `IINA → Settings → Plugins → Install Package`.

You can also install from GitHub using:

```text
https://github.com/fivepool/iina-clip-recorder
```

## Usage

1. Open a local video file.
2. Press `⌘R` at the start of the clip.
3. Press `⌘R` again at the end. Export starts automatically.

The result card shows the clip duration and can reveal the saved file in
Finder.

## Settings

- Output: MP4, GIF, or both.
- MP4: 1080p or full resolution; audio on or off.
- GIF: 720p or full resolution; 12 fps or source frame rate.
- Output folder, shortcut, and FFmpeg path.

## Notes

- Local files are supported. Network streams and DRM are not.
- HDR sources are not supported in this version.
- GIF files can be much larger and slower to create than MP4 files.
- If the end marker is earlier than the start marker, the selection is reset.

More details: [architecture](docs/architecture.md),
[known limitations](docs/known-limitations.md), and
[manual test plan](docs/manual-test-plan.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run pack
```

## License

Currently published without an open-source license (`UNLICENSED`). FFmpeg is
not included in the plugin package.
