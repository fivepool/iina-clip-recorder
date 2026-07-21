export const MAXIMUM_BASENAME_UTF8_BYTES = 220;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function formatTimestamp(date: Date): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join("_");
}

export function formatMediaTimeForFilename(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const wholeSeconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours)}h${pad(minutes)}m${pad(wholeSeconds)}s${pad(milliseconds, 3)}`;
}

export function sourceStem(sourcePath: string): string {
  const basename = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  const lastDot = basename.lastIndexOf(".");
  return lastDot > 0 ? basename.slice(0, lastDot) : basename;
}

export function sanitizeFilenameComponent(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f/:]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  const safe = cleaned.length > 0 ? cleaned : "video";
  return safe;
}

export function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

function truncateToUtf8Bytes(value: string, maximumBytes: number): string {
  let result = "";
  let usedBytes = 0;
  for (const character of Array.from(value)) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

export function buildClipBasename(
  sourcePath: string,
  createdAt: Date,
  start: number,
  end: number,
): string {
  const suffix = [
    "clip",
    formatTimestamp(createdAt),
    `${formatMediaTimeForFilename(start)}-${formatMediaTimeForFilename(end)}`,
  ].join("_");
  const stemBudget = Math.max(
    1,
    MAXIMUM_BASENAME_UTF8_BYTES - utf8ByteLength(suffix) - 1,
  );
  const sanitizedStem = sanitizeFilenameComponent(sourceStem(sourcePath));
  const stem = truncateToUtf8Bytes(sanitizedStem, stemBudget) || "video";
  return `${stem}_${suffix}`;
}

function joinPath(directory: string, filename: string): string {
  return directory === "/"
    ? `/${filename}`
    : `${directory.replace(/\/+$/, "")}/${filename}`;
}

export function chooseAvailableOutputPath(
  directory: string,
  basename: string,
  extension: string,
  exists: (path: string) => boolean,
  maximumAttempts = 10_000,
): string {
  const normalizedExtension = extension.replace(/^\.+/, "");
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const suffix = attempt === 1 ? "" : `_${attempt}`;
    const path = joinPath(directory, `${basename}${suffix}.${normalizedExtension}`);
    if (!exists(path)) {
      return path;
    }
  }
  throw new Error("Unable to allocate a unique output filename");
}
