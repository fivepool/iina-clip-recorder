export interface MediaSnapshot {
  readonly sourcePath: string;
  readonly sourceUrl: string;
  readonly sourceName: string;
  readonly startPosition: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number | null;
  readonly selectedVideoStreamIndex: number | null;
  readonly selectedVideoIsExternal: boolean;
  readonly hasEmbeddedAudio: boolean;
  readonly selectedEmbeddedAudioStreamIndex: number | null;
  readonly selectedAudioIsExternal: boolean;
  readonly videoParameters: Readonly<Record<string, unknown>> | null;
  readonly isHdr: boolean;
}

export interface ClipRange {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
