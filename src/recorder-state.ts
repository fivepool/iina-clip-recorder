import type { ClipRange, MediaSnapshot } from "./types";

export type RecorderState =
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly snapshot: MediaSnapshot }
  | {
      readonly kind: "preflighting";
      readonly snapshot: MediaSnapshot;
      readonly range: ClipRange;
    }
  | {
      readonly kind: "encoding";
      readonly snapshot: MediaSnapshot;
      readonly range: ClipRange;
    }
  | { readonly kind: "error"; readonly message: string };

export type RecorderEvent =
  | { readonly type: "start"; readonly snapshot: MediaSnapshot }
  | { readonly type: "stop"; readonly range: ClipRange }
  | { readonly type: "beginEncoding" }
  | { readonly type: "complete" }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly message: string }
  | { readonly type: "reset" };

export function initialRecorderState(): RecorderState {
  return { kind: "idle" };
}

export function reduceRecorderState(
  state: RecorderState,
  event: RecorderEvent,
): RecorderState {
  if (event.type === "reset") {
    return initialRecorderState();
  }
  if (event.type === "fail") {
    return { kind: "error", message: event.message };
  }

  switch (state.kind) {
    case "idle":
      if (event.type === "start") {
        return { kind: "recording", snapshot: event.snapshot };
      }
      break;
    case "recording":
      if (event.type === "stop") {
        return {
          kind: "preflighting",
          snapshot: state.snapshot,
          range: event.range,
        };
      }
      if (event.type === "cancel") {
        return initialRecorderState();
      }
      break;
    case "preflighting":
      if (event.type === "beginEncoding") {
        return {
          kind: "encoding",
          snapshot: state.snapshot,
          range: state.range,
        };
      }
      if (event.type === "cancel") {
        return initialRecorderState();
      }
      break;
    case "encoding":
      if (event.type === "complete") {
        return initialRecorderState();
      }
      break;
    case "error":
      if (event.type === "cancel") {
        return initialRecorderState();
      }
      break;
  }

  throw new Error(`Invalid recorder transition: ${state.kind} + ${event.type}`);
}
