# Архитектура IINA Clip Recorder

Цель архитектуры — экспортировать диапазон media timeline без screen capture и
без непрерывного кодирования во время просмотра.

## Поток выполнения

```text
idle
  └─ shortcut/menu → recording
       ├─ source/window change → idle
       └─ second marker/EOF → preflighting
            ├─ invalid source/range/disk → error → idle
            ├─ Cancel/source/window change → idle
            └─ accepted → encoding
                 ├─ all failed → error → idle
                 └─ full/partial success → idle
```

`recording` хранит immutable media snapshot. `preflighting` отделён от
`encoding`, потому что до подтверждения пользователя ни один FFmpeg process не
должен считаться запущенным. Повторный shortcut в этих состояниях не создаёт
вторую задачу.

## Snapshot источника

При первом маркере фиксируются:

- абсолютный local path и отображаемое имя;
- start position и finite duration;
- width/height, scalar source FPS для оценки;
- выбранный FFmpeg video stream index;
- выбранный embedded audio stream index;
- наличие embedded audio;
- video parameter maps для HDR-проверки;
- fingerprint `device:inode:size:mtime`;
- Preferences и найденный FFmpeg executable.

Network и external video sources отклоняются. External audio отклоняется только
когда включён MP4 со звуком.

Fingerprint снимается через:

```text
/usr/bin/stat -L -f %d:%i:%z:%m <source>
```

Вызов shell-free. Fingerprint повторно проверяется до encoding, перед GIF
palette/encode phases и перед libx264 fallback.

## Range

Второй marker читается из `iina.core.status.position`. `validateClipRange`:

- clamp-ит start/end к `[0, duration]`;
- требует минимум 0,1 секунды;
- отклоняет end < start;
- не использует wall-clock elapsed.

Property callback IINA 1.4.4 передаёт `eof-reached` как `0/1` double.
Нормализатор принимает boolean и numeric payload. Этого недостаточно для
auto-next: mpv логически сбрасывает EOF почти сразу, а public `mpv.end-file`
в IINA не передаёт native `reason`.

Поэтому плагин использует public synchronous mpv hook `on_unload`. Hook
удерживает старый файл, через IINA timer переходит на main queue и там
фиксирует `eof-reached` до выгрузки source. Natural EOF-triggered export
разрешает ровно один следующий `iina.file-started`, продолжая работу из
immutable snapshot старого пути. Второй source transition уже отменяет
preflight или скрывает UI encoding job. Manual unload имеет
`eof-reached=false` и сохраняет обычную cancel semantics.

## Preflight

После второго marker:

1. state переходит в `preflighting`;
2. output directory создаётся и проходит write probe;
3. fingerprint проверяется;
4. рассчитывается оценка MP4/GIF;
5. `/bin/df -Pk` проверяет output и `@tmp/.`;
6. явно недостаточное место блокирует export;
7. threshold или недостаточный внутренний резерв места показывает clickable
   confirmation overlay;
8. после `Export` source/lifecycle/fingerprint проверяются ещё раз;
9. state переходит в `encoding`.

### Оценка MP4

Средняя оценка:

```text
duration × (7,000,000 video + optional 192,000 audio) / 8
× container margin
```

Planning value выше из-за libx264 CRF fallback.

### Оценка GIF

Средняя оценка:

```text
output pixels × estimated frames × 0.30 bytes/pixel-frame
```

720p использует максимум 1280×720 без upscale. Match Source берёт reported FPS,
а при его отсутствии — консервативные 60 fps. Planning estimate использует
более высокий предел на pixel-frame.

### Disk model

Если output и `@tmp` на одном filesystem, учитывается peak всей
последовательности. Если volumes различаются:

- destination должен вместить сумму final outputs;
- temporary volume — максимальный single unfinished job;
- к planning value добавляется минимум 256 MiB headroom.

## MP4 pipeline

`buildMp4Args` создаёт argv без shell:

- input `-ss` + `-t`;
- strict selected video map;
- strict selected embedded audio map либо `-an`;
- subtitles/data отключены;
- SAR-aware 1920×1080 scale без upscale либо even Full Resolution;
- `h264_videotoolbox`, 7000k, yuv420p, avc1;
- `-fps_mode:v passthrough`;
- `-enc_time_base:v -1`;
- AAC 192k;
- `+faststart`.

Если hardware attempt падает по encoder-specific причине, temporary output
удаляется, fingerprint проверяется снова и запускается libx264 CRF 20/preset
fast. Не связанные с encoder ошибки, например disk full, не маскируются
fallback.

## GIF pipeline

Оба прохода используют один range и выбранный video stream.

Palette:

```text
scale/fps → palettegen=max_colors=256:stats_mode=diff
```

Encode:

```text
scale/fps → paletteuse=dither=sierra2_4a:diff_mode=rectangle
```

Для 12 fps применяется `fps=12`. Для Match Source FPS filter отсутствует, а
timestamps передаются GIF muxer; формат округляет delays до 1/100 секунды.

Palette и GIF output имеют уникальные `@tmp` имена. Cleanup выполняется в
`finally`.

## Dual export и promotion

IINA 1.4.4 использует одну serial process queue на plugin instance. Поэтому
MP4 и GIF выполняются последовательно, но возвращают независимые typed
outcomes.

Каждый format:

1. кодируется в `@tmp`;
2. использует `-n`;
3. получает collision-safe final path;
4. перемещается `/bin/mv -n`;
5. проверяется существование final и отсутствие temporary.

Успех одного формата сохраняется при падении другого.

## Overlay

Есть три режима одного public `iina.overlay`:

- simple — REC/Checking/Encoding/error badges;
- saved — `overlay/clip-saved.html`;
- confirmation — `overlay/export-warning.html`.

Большие saved/confirmation cards используют один сдержанный glass material:
полупрозрачный градиент, `backdrop-filter` blur+saturation, тонкую светлую
границу и мягкую тень. Simple REC/Encoding badges используют более тёмный
вариант того же материала, чтобы оставаться читаемыми на светлых кадрах.

`loadFile()` и `simpleMode()` в IINA 1.4.4 очищают message listeners. Поэтому
Reveal/Export/Cancel handlers регистрируются только после
`iina.plugin-overlay-loaded`.

Confirmation card показывает approximate output, free space и одну
синтезированную причину. Внутренний planning value не отображается как
максимальный размер. Для player windows высотой до 220 px используется
компактная responsive раскладка, сохраняющая обе кнопки.

Clickable HTML elements имеют `data-clickable`. WebView всегда вызывает
`iina.postMessage(name, null)`: undefined payload bridge IINA 1.4.4 теряет.

Confirmation Promise завершается ровно один раз. Hide, source change, window
close или replacement prompt разрешают его как `false`.

## Preferences и shortcut

Preferences Page — локальные HTML/CSS/JS assets. Она хранит:

- shortcut;
- MP4/GIF toggles;
- MP4 audio toggle;
- resolutions;
- GIF FPS;
- output directory;
- FFmpeg path.

Export preferences читаются перед новым selection. Shortcut регистрируется
через `iina.input.onKeyDown` с high priority; `isRepeat` игнорируется.
Dynamic menu key equivalent не используется из-за небезопасной mutation
lifecycle в IINA 1.4.4.

## Модули

```text
src/main.ts                 orchestration и lifecycle
src/recorder-state.ts       state reducer
src/media-info.ts           IINA/mpv snapshot и HDR
src/source-fingerprint.ts   stat parser/checks
src/clip-range.ts           range validation
src/preferences.ts          runtime preference validation
src/shortcut.ts             input/menu integration
src/export-lifecycle.ts     EOF/playlist generation policy
src/export-confirmation.ts  компактная confirmation model/copy
src/export-preflight.ts     estimates и risk thresholds
src/disk-space.ts           df parser и filesystem model
src/export-mp4.ts           MP4 argv/fallback
src/export-gif.ts           GIF palette workflow
src/dimensions.ts           scale policies
src/ffmpeg.ts               discovery/process/runtime/temp/promotion
src/filenames.ts            names/collision/UTF-8 limits
src/overlay.ts              visual modes and WebView bridge
src/notifications.ts        result models/messages
```

## Packaging

`.iinaplgz` содержит только manifest, runtime bundle, Preferences и overlay.
В пакет не входят:

- TypeScript sources;
- tests/scripts;
- node_modules;
- generated media;
- source maps и внутренние engineering docs;
- repository README;
- FFmpeg.

Manifest `0.4.2`:

```text
identifier: com.inkolor.iina-clip-recorder
ghRepo: fivepool/iina-clip-recorder
ghVersion: 1
author: Maksim Arkatov
url: https://maksimarkatov.com
```
