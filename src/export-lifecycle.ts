export interface ExportLifecycle {
  readonly originGeneration: number;
  readonly maximumVisibleGeneration: number;
  readonly sourceMayDetach: boolean;
}

export function createExportLifecycle(
  generation: number,
  sourceMayDetach: boolean,
  sourceIsStillCurrent: boolean,
): ExportLifecycle {
  return {
    originGeneration: generation,
    maximumVisibleGeneration:
      generation + (sourceMayDetach && sourceIsStillCurrent ? 1 : 0),
    sourceMayDetach,
  };
}

export function exportLifecycleIsCurrent(
  lifecycle: ExportLifecycle,
  generation: number,
  sourceIsStillCurrent: boolean,
): boolean {
  if (
    generation < lifecycle.originGeneration ||
    generation > lifecycle.maximumVisibleGeneration
  ) {
    return false;
  }
  return lifecycle.sourceMayDetach || sourceIsStillCurrent;
}

export function sourceStartBelongsToNaturalEof(
  lifecycle: ExportLifecycle | null,
  generation: number,
): boolean {
  return (
    lifecycle !== null &&
    lifecycle.sourceMayDetach &&
    generation > lifecycle.originGeneration &&
    generation <= lifecycle.maximumVisibleGeneration
  );
}
