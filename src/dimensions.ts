export interface SourceGeometry {
  readonly width: number;
  readonly height: number;
  readonly sampleAspectRatio?: number;
  readonly rotation?: number;
}

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

function evenFloor(value: number, upperBound: number): number {
  const bounded = Math.min(value, upperBound);
  return Math.max(2, Math.floor(bounded / 2) * 2);
}

export function calculateBoundedDimensions(
  source: SourceGeometry,
  bounds: Dimensions,
): Dimensions {
  requirePositiveFinite(source.width, "source width");
  requirePositiveFinite(source.height, "source height");
  requirePositiveFinite(bounds.width, "maximum width");
  requirePositiveFinite(bounds.height, "maximum height");

  const sar = source.sampleAspectRatio ?? 1;
  requirePositiveFinite(sar, "sample aspect ratio");

  const normalizedRotation = ((source.rotation ?? 0) % 360 + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;

  const unrotatedDisplayWidth = source.width * sar;
  const unrotatedDisplayHeight = source.height;
  const displayWidth = swapsAxes ? unrotatedDisplayHeight : unrotatedDisplayWidth;
  const displayHeight = swapsAxes ? unrotatedDisplayWidth : unrotatedDisplayHeight;
  const rasterWidth = swapsAxes ? source.height : source.width;
  const rasterHeight = swapsAxes ? source.width : source.height;

  const scale = Math.min(
    1,
    bounds.width / displayWidth,
    bounds.height / displayHeight,
    rasterWidth / displayWidth,
    rasterHeight / displayHeight,
  );

  return {
    width: evenFloor(displayWidth * scale, bounds.width),
    height: evenFloor(displayHeight * scale, bounds.height),
  };
}

/**
 * Produce square-pixel, even dimensions inside a box without enlarging the
 * source's display dimensions. This expression works on the frames after
 * FFmpeg's default autorotation and keeps anamorphic input display geometry.
 */
export function buildSarAwareScaleFilter(
  maximumWidth: number,
  maximumHeight: number,
): string {
  requirePositiveFinite(maximumWidth, "maximum width");
  requirePositiveFinite(maximumHeight, "maximum height");

  const maxWidth = Math.floor(maximumWidth);
  const maxHeight = Math.floor(maximumHeight);
  // The 1/sar term prevents a wide-pixel anamorphic source (SAR > 1)
  // from gaining raster pixels merely to become square-pixel. Instead, the
  // other axis is reduced so display aspect ratio is preserved without
  // exceeding either decoded source dimension.
  const factor = `min(1,min(1/sar,min(${maxWidth}/(iw*sar),${maxHeight}/ih)))`;
  const width = `max(2,trunc(iw*sar*${factor}/2)*2)`;
  const height = `max(2,trunc(ih*${factor}/2)*2)`;
  return `scale=w='${width}':h='${height}':flags=lanczos,setsar=1`;
}

/**
 * Keep the decoded frame at full resolution while making dimensions legal for
 * yuv420p/H.264. The scale filter preserves display aspect ratio by adjusting
 * SAR when an odd source dimension must lose one pixel.
 */
export function buildEvenFullResolutionFilter(): string {
  const width = "max(2,trunc(iw/2)*2)";
  const height = "max(2,trunc(ih/2)*2)";
  return `scale=w='${width}':h='${height}':flags=lanczos`;
}
