# Известные ограничения

Актуально для IINA Clip Recorder `0.4.2`, IINA 1.4.4 build 168.

## Источники

- Поддерживаются только обычные локальные видеофайлы с конечной длительностью.
- Network URL, HTTP, HLS, DASH, временные manifests, cookies/headers и DRM не
  поддерживаются.
- Screen capture не используется как скрытый fallback.
- External video tracks отклоняются.
- External audio tracks для MP4 отклоняются; нужно выбрать embedded track или
  включить `Export without audio`.
- Если в файле несколько video streams, IINA должен предоставить
  `current-tracks/video.ff-index`; иначе плагин не делает неоднозначный экспорт.

## HDR

- Известные BT.2020, PQ, HLG, SMPTE ST 2084 и повышенный signal peak
  отклоняются до первого маркера.
- HDR → SDR tone mapping и сохранение HDR metadata не реализованы.
- Это консервативная проверка по `video-dec-params` и `video-params`. Редкий
  HDR-файл с отсутствующей или ошибочной metadata теоретически может остаться
  нераспознанным.

## Размер и свободное место

- MP4 estimate строится от 7 Мбит/с, optional AAC 192 кбит/с и container
  margin. При fallback на libx264 используется CRF, поэтому фактический размер
  может заметно отличаться.
- GIF estimate калиброван на реальных Stage 4 outputs по выходному разрешению
  и ожидаемому числу кадров. Движение, зерно, шум и dithering способны изменить
  результат в несколько раз.
- Resolution и FPS учитываются в приблизительной оценке размера и внутреннем
  резерве места, но сами по себе отдельного confirmation threshold не создают.
- Planning reserve и `df -Pk` снижают риск, но не являются квотой: APFS,
  purgeable capacity и параллельное потребление диска меняются после preflight.
- При output на другом volume место требуется и в plugin `@tmp`, и в output
  directory. Cross-volume `mv` не гарантированно атомарен.
- Hard block по приблизительной оценке в пограничном случае может оказаться
  консервативным. Плагин не уменьшает resolution/FPS/палитру автоматически.

## FFmpeg и lifecycle

- IINA содержит FFmpeg libraries, но не предоставляет plugin API или
  executable для transcoding; нужен внешний FFmpeg.
- Bare-name PATH lookup в IINA 1.4.4 ненадёжен, поэтому используются
  подтверждённые absolute candidates.
- `iina.utils.exec` не возвращает PID и не предоставляет cancellation.
  Закрытие окна во время encoding скрывает UI, но уже запущенный FFmpeg может
  завершиться в фоне.
- Dual export выполняется последовательно, хотя outcomes независимы. IINA
  1.4.4 сериализует ожидание `utils.exec`, и псевдопараллельные encode/move
  цепочки создавали ordering risk.
- До начала каждого FFmpeg phase проверяется fingerprint
  `device:inode:size:mtime`. Изменение с тем же inode, размером и mtime в
  пределах точности filesystem остаётся теоретической race.
- Если исходник изменится уже внутри активного FFmpeg process, Plugin API не
  позволяет остановить его немедленно; process должен завершиться или упасть.
- При старте удаляются только `clip-recorder-*` temporary files старше 24 часов.
  Более свежие leftovers сохраняются, чтобы не задеть job другого окна.
- IINA не передаёт plugin callback поле `reason` события `mpv.end-file`.
  Natural EOF различается через public `on_unload` hook и `eof-reached`, пока
  старый файл ещё удерживается. Ручное переключение уже после фактически
  достигнутого EOF неотличимо от automatic playlist advance; к этому моменту
  EOF-export обычно уже запущен.

## Видео, FPS и GIF

- MP4 VFR path использует passthrough timestamps и source encoder time base.
  Он проверен на синтетическом VFR через libx264; VideoToolbox VFR остаётся
  обязательным ручным regression case.
- GIF хранит delays с дискретностью 1/100 секунды. 12 fps представляется
  чередованием примерно 0,08/0,09 секунды, а Match Source не может идеально
  сохранить интервалы тоньше этой сетки.
- GIF Full Resolution на anamorphic source преобразует изображение в square
  pixels без upscale и поэтому может уменьшить одну из raster dimensions.
- MP4 Full Resolution округляет odd dimensions вниз до допустимых для
  yuv420p/H.264; scale filter сохраняет display aspect ratio через SAR.
- Source dimensions меньше 2 pixels отклоняются.
- GIF легко становится больше MP4 на порядок. По продуктовому решению
  дополнительные FPS/color presets не добавляются.

## Audio

- Выбранная embedded audio track маппится строго по FFmpeg stream index.
- Если embedded audio есть, но выбранный index недоступен, используется
  первый embedded audio stream.
- Если embedded audio отсутствует, MP4 получает явный `-an`.
- Дорожки subtitles, data и attachments не переносятся.

## UI и Preferences

- Native screenshot accessory view IINA является private Swift UI. Плагин
  использует public overlay и `iina.file.showInFinder`.
- Success card исчезает через 4 секунды. Error card остаётся 10 секунд.
- Export confirmation не исчезает автоматически и требует `Export` или
  `Cancel`.
- Menu item не показывает динамический key equivalent. Настраиваемый shortcut
  реализован через `iina.input`; runtime mutation menu item в IINA 1.4.4
  оказалась crash-prone.
- Shortcut preference применяется после restart IINA; `Reload All Plugins`
  обычно достаточен при неизменном identifier. После смены identifier нужен
  полный restart IINA; уже созданный player runtime может сохранять старую
  версию до закрытия. Старые зарегистрированные callbacks остаются inert по
  active-key guard.
- Preferences bridge возвращает Bool как `0/1`; страница явно нормализует эти
  значения.
- Пути с пробелами, кириллицей и emoji проверены. Из-за дефекта string callback
  Preferences bridge IINA 1.4.4 кавычки, backslash и newline в текстовом поле
  пути не считаются надёжно round-trip-safe.
- Native chooser output directory/executable недоступен в Preferences context,
  поэтому используются текстовые поля.

## Release и migration

- Identifier `com.inkolor.iina-clip-recorder` впервые используется в `0.4.1`.
- Настройки development-версий с `com.example.iina-clip-recorder` и release
  candidate `0.4.0` с `com.maksimarkatov.iina-clip-recorder` автоматически не
  мигрируют и один раз вернутся к defaults.
- Установленный пакет со старым identifier необходимо удалить отдельно: IINA
  допускает его сосуществование с новым, что создаст дублирующий shortcut.
- FFmpeg binary не входит в `.iinaplgz`; решение о bundled universal binary
  отложено из-за размера, лицензирования и arm64/x86_64 distribution.
