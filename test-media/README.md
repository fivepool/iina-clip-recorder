# Stage 5 test media

Generated video fixtures are intentionally excluded from the plugin package
and source tree history. Create them locally with:

```sh
pnpm fixtures:generate
pnpm fixtures:verify
```

The default output directory is `test-media/generated/`. It contains compact
synthetic inputs for 23.976 fps, 4K/25, 4K/59.94, portrait, 720p, sub-720p,
VFR, no-audio, multi-audio, rotation metadata, anamorphic SAR, odd dimensions,
10-bit 4:2:2 SDR with reserved/null transfer metadata, HDR metadata, long-range
warnings, and Unicode paths. The reserved/null transfer regression is exercised
with Homebrew FFmpeg 8.1.1 and 9.0.1.

No copyrighted footage is used.
