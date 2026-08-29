# План реализации IINA Clip Recorder

Обновлено 17 июля 2026 года. Target: IINA 1.4.4 build 168, macOS.

## Статус этапов

- [x] Этап 1 — аудит Plugin API, types и исходников IINA 1.4.4.
- [x] Этап 2 — vertical slice: marker pair, overlay, local MP4.
- [x] Этап 3 — Preferences, configurable shortcut, resolutions/paths.
- [x] Этап 4 — GIF, dual export, partial success, result card.
- [x] Этап 5 — code hardening, estimates/disk preflight, media fixtures,
  release metadata и package build.
- [ ] Финальный release gate — оставшаяся ручная GIF/dual/UI/error matrix
  в IINA 1.4.4. Clean-install baseline и packaged MP4 smoke уже пройдены.

Текущий public beta target: `0.4.3`.

UI overlay в `0.4.2` приведён к единому умеренно матовому glass-стилю без
добавления новых элементов или сообщений.

## Подтверждённые возможности API

Проверено по `iina-plugin-definition 0.99.3` и исходникам IINA 1.4.4.

| API | Подтверждённое использование | Ограничение |
| --- | --- | --- |
| `iina.core.status` | idle, URL/network flag, position, duration, video dimensions | Position/duration nullable; scalar FPS не описывает VFR |
| `iina.core.video/audio.tracks` | selected/default tracks, embedded/external status, demux FPS | Для точного FFmpeg map нужен `current-tracks/*` |
| `iina.mpv` | `path`, parameter maps, current tracks, EOF flag, `on_unload` hook | New property events наблюдаются как double; flags приходят `0/1` |
| `iina.event` | window/file lifecycle, EOF/end-file, overlay-loaded | `end-file` не передаёт plugin callback native `reason` |
| `iina.menu` | статические Start/Stop и Show Last Clip | Dynamic key equivalent/mutation небезопасны в 1.4.4 |
| `iina.input` | нормализация, key binding lookup, high-priority keydown, repeat flag | unregister typing/runtime расходятся; inactive callbacks guard-ятся |
| `iina.overlay` | simple content, HTML file, clickable hit-test, message bridge | `loadFile/simpleMode` очищают listeners |
| `iina.preferences` | namespaced get/set/sync в main entry | Preferences WebView имеет урезанный async bridge и не имеет change event |
| `iina.file` | exists/delete/showInFinder | Нет native chooser, stat или free-space API |
| `iina.utils.exec` | executable + argv, async result/stdout/stderr | Нет PID, cancellation или reliable progress channel |
| `iina.utils.fileInPath` | первый bare-name probe | Ordinary PATH IINA 1.4.4 ненадёжен |
| `iina.utils.resolvePath` | `~/`, `@tmp/.` | Нужно проверять absolute resolved result |
| `iina.utils.open` | публичное открытие URL/path | Finder selection надёжнее через `file.showInFinder` |

`utils.exec` передаёт argv в Foundation `Process.arguments`, а не shell.
Пользовательские пути никогда не конкатенируются в command string.

## Native screenshot notification

Screenshot notification IINA реализована private Swift accessory view с
preview и действиями. Публичного plugin API для её создания нет.

Выбранная реализация:

1. public HTML video overlay, визуально близкий по размеру/типографике;
2. один action `Reveal in Finder`;
3. `iina.file.showInFinder` для точного результата;
4. без отдельного screenshot/decode ради preview.

## Media metadata

| Данные | Источник |
| --- | --- |
| Local path | `mpv path`, только absolute `/…` |
| Position/duration | `core.status.position/duration` |
| Dimensions | `video-dec-params` + `video-params`, fallback core status |
| FPS estimate | selected track `demuxFPS`, fallback `container-fps` |
| Selected video | `current-tracks/video.ff-index` |
| Selected audio | `current-tracks/audio.ff-index` |
| Embedded/external | track list и current-track parameter maps |
| HDR | оба parameter maps: primaries/transfer/signal peak |
| Source identity | `/usr/bin/stat -L -f %d:%i:%z:%m` |
| Filename | basename absolute path, sanitized и UTF-8 bounded |

VFR нельзя определить одним FPS. MP4 сохраняет timestamps через
`-fps_mode:v passthrough -enc_time_base:v demux`; integration gate сравнивает
frame PTS. Строковое значение `demux` заменило устаревшее числовое `-1` и
совместимо с текущими Homebrew FFmpeg 8.x.

## FFmpeg discovery

Порядок:

1. custom absolute preference;
2. `ffmpeg`, если IINA подтверждает его через `fileInPath`;
3. `/opt/homebrew/bin/ffmpeg`;
4. `/usr/local/bin/ffmpeg`;
5. `/opt/local/bin/ffmpeg`.

Каждый candidate запускается с `-version`.

FFmpeg из внутренних libraries IINA публично недоступен. Bundled binary не
входит в `0.4.1`: нужен отдельный анализ GPL/LGPL configuration, размера и
universal arm64/x86_64 distribution.

## Выбранная архитектура

Основная state machine:

```text
idle → recording → preflighting → encoding → idle
                    ↘ cancel/error ↗
```

Первый marker фиксирует snapshot и fingerprint. Второй marker валидирует range,
запускает estimates/output/disk/source preflight и только после подтверждения
переходит к FFmpeg.

Подробности — в [architecture.md](architecture.md).

## MP4

- H.264 MP4, yuv420p, avc1;
- VideoToolbox около 7000k;
- AAC 192k только при embedded audio и включённом звуке;
- fallback libx264 CRF 20/preset fast;
- selected video/audio mapped строго;
- 1080p: 1920×1080 box, SAR-aware square pixels, even, no upscale;
- Full: source raster после autorotation, odd dimensions округляются;
- no `-r`; VFR source time base;
- encode в unique `@tmp`, затем no-overwrite promotion.

Stream copy исключён: нужны точный range, scaling и совместимый output.

## GIF

- без audio;
- 720p box или Full;
- 12 fps или Match Source;
- separate input-limited palette and encode passes;
- `palettegen=max_colors=256:stats_mode=diff`;
- `paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
- unique palette PNG;
- cleanup в `finally`.

Дополнительные quality presets сознательно не добавляются.

## Dual export

Оба формата используют общий range и snapshot. Jobs независимы по outcome, но
выполняются последовательно из-за serial queue IINA 1.4.4.

- MP4 success + GIF failure сохраняет MP4;
- GIF success + MP4 failure сохраняет GIF;
- all failure возвращает state в idle через error;
- итоговая карточка перечисляет success и failed formats.

## Stage 5 safeguards

Реализовано:

- отдельный `preflighting` state;
- приблизительная оценка каждого format;
- `/bin/df -Pk` для output и `@tmp/.`;
- same/cross-filesystem peak model;
- minimum 256 MiB planning headroom;
- hard stop при месте ниже приблизительной оценки;
- `Export / Cancel` overlay;
- cancel на source/window change;
- source fingerprint между FFmpeg phases;
- cleanup plugin temp files старше 24 часов.
- natural EOF latch через public `on_unload` hook до выгрузки старого source;
- ровно один допустимый playlist advance для EOF-triggered immutable export.

Confirmation thresholds:

- total estimate ≥ 512 MiB;
- range ≥ 300 s;
- planning reserve не помещается, хотя средняя оценка помещается.

## Альтернативные архитектуры

### Screen capture

Отклонено: захватывает OSC/subtitles/display transform, требует screen-recording
permission и не соответствует точным source timestamps.

### Continuous encoding с первого marker

Отклонено: лишняя CPU/GPU нагрузка, сложная pause/seek semantics и плохой UX.

### mpv A/B loop + command

Полезно для UI, но не заменяет независимый export pipeline и FFmpeg controls.

### Stream copy

Не подходит для scaling, exact cuts и единообразного H.264 output.

### Bundled FFmpeg

Отложено, а не отвергнуто. Требует отдельного distribution/licensing решения.

### Parallel MP4 + GIF

Изначально предпочтительно, но runtime IINA 1.4.4 сериализует `utils.exec`
completion и создаёт promotion ordering risk. Последовательность выбрана как
детерминированная реализация MVP.

## Структура

```text
Info.json
package.json
src/
  main.ts
  recorder-state.ts
  media-info.ts
  source-fingerprint.ts
  clip-range.ts
  preferences.ts
  shortcut.ts
  export-lifecycle.ts
  export-confirmation.ts
  export-preflight.ts
  disk-space.ts
  ffmpeg.ts
  export-mp4.ts
  export-gif.ts
  dimensions.ts
  filenames.ts
  overlay.ts
  notifications.ts
preferences/
  preferences.html
  preferences.css
  preferences.js
  preferences-core.js
overlay/
  clip-saved.html
  export-warning.html
tests/
  unit.test.ts
  overlay-page.test.cjs
  preferences-page.test.cjs
  media-integration.ts
test-media/
  README.md
  generated/                 ignored
scripts/
  check.sh
  link-dev.sh
  unlink-dev.sh
  pack.sh
  generate-test-media.sh
  verify-test-media.mjs
  fixtures/
docs/
  implementation-plan.md
  architecture.md
  manual-test-plan.md
  known-limitations.md
README.md
```

## Риски

| Риск | Митигация |
| --- | --- |
| GIF/libx264 size непредсказуем | calibrated estimate + hidden planning reserve |
| Свободное место меняется после df | temp outputs, actionable FFmpeg errors |
| Source заменён между markers/passes | fingerprint checks |
| Source меняется внутри process | документировать: cancellation API отсутствует |
| VFR quantization | source encoder time base + frame PTS integration test |
| HDR выглядит сломанным | known HDR hard reject |
| Wrong selected stream | strict ff-index map, ambiguous multi-video reject |
| Rotation/SAR/odd | FFmpeg autorotation, SAR-aware filters, generated fixtures |
| Host crash от menu/polling lifecycle | static menu, no mutation, no live polling |
| EOF flag сбрасывается при auto-next | main-queue `on_unload` latch + one-generation lifecycle allowance |
| Overlay listener lost | register only after overlay-loaded |
| Cross-volume promotion | disk check обоих volumes, guarded mv; race documented |
| Identifier migration | `com.inkolor…` from 0.4.1, one-time reset documented |

## Тестирование

Automated:

- 30 TypeScript tests;
- 6 WebView/overlay tests;
- TypeScript main/test typecheck;
- bundle and asset validation;
- package content/version/integrity checks.

Generated fixture verification:

- 1920×1080 23.976 + AAC;
- 4K/25 и 4K/59.94;
- portrait, 720p, sub-720p;
- real VFR;
- no-audio и two-audio;
- rotation 90°;
- anamorphic SAR 16:15;
- odd 641×359;
- HDR10 tags;
- Unicode path;
- 35-second medium-duration source.
- 305-second boundary-warning source.

Media integration:

- no-upscale;
- portrait scaling;
- autorotation;
- SAR/DAR;
- odd even-output;
- selected audio;
- no-audio;
- VFR PTS preservation via libx264;
- GIF palette workflow.

Полная ручная матрица описана в
[manual-test-plan.md](manual-test-plan.md).

## Release metadata

```json
{
  "identifier": "com.inkolor.iina-clip-recorder",
  "version": "0.4.2",
  "author": {
    "name": "Maksim Arkatov",
    "url": "https://maksimarkatov.com"
  }
}
```

## Критерии приёмки

Code gate:

- [x] start/end markers, REC/Encoding UI;
- [x] MP4 audio/silent, scaling, VideoToolbox/fallback;
- [x] GIF palette workflow and controls;
- [x] dual/partial outcomes;
- [x] Preferences persistence implementation;
- [x] Unicode shell-free paths;
- [x] preflight estimates/free space/confirmation;
- [x] source/stream/HDR hardening;
- [x] natural EOF export через playlist auto-advance;
- [x] generated media integration;
- [x] permanent author/identifier/version;
- [x] `.iinaplgz` packaging automation.
- [x] GitHub install/update metadata (`ghRepo`, `ghVersion`).
- [x] public README, CI configuration and minimal runtime-only package.

Release gate:

- [x] install `0.4.2.iinaplgz` without development link;
- [x] reverify metadata, permissions, Preferences and runtime assets after the
  identifier change;
- [ ] reverify packaged MP4 at natural EOF after the identifier change;
- [ ] verify packaged GIF/dual and remaining confirmation paths in IINA 1.4.4;
- [ ] finish remaining manual UI/error matrix or mark each unavailable case
  explicitly `BLOCKED`.
