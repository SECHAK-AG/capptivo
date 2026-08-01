/** Typed listeners for Rust `recorder://…` events. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecorderState } from "./types";

export const RecorderChannels = {
  stateChanged: "recorder://state-changed",
  elapsed: "recorder://elapsed",
  level: "recorder://level",
  error: "recorder://error",
  interrupted: "recorder://interrupted",
} as const;

type StateChangedPayload = { stateChanged: { state: RecorderState } };
type ElapsedPayload = { elapsed: { seconds: number } };
type LevelPayload = { level: { micDb: number } };
type ErrorPayload = { error: { message: string; fatal: boolean } };
type InterruptedPayload = { interrupted: { framesEncoded: number } };

export function onStateChanged(
  handler: (state: RecorderState) => void,
): Promise<UnlistenFn> {
  return listen<StateChangedPayload>(RecorderChannels.stateChanged, (e) =>
    handler(e.payload.stateChanged.state),
  );
}

export function onElapsed(
  handler: (seconds: number) => void,
): Promise<UnlistenFn> {
  return listen<ElapsedPayload>(RecorderChannels.elapsed, (e) =>
    handler(e.payload.elapsed.seconds),
  );
}

export function onLevel(handler: (micDb: number) => void): Promise<UnlistenFn> {
  return listen<LevelPayload>(RecorderChannels.level, (e) =>
    handler(e.payload.level.micDb),
  );
}

export function onError(
  handler: (message: string, fatal: boolean) => void,
): Promise<UnlistenFn> {
  return listen<ErrorPayload>(RecorderChannels.error, (e) =>
    handler(e.payload.error.message, e.payload.error.fatal),
  );
}

export function onInterrupted(
  handler: (framesEncoded: number) => void,
): Promise<UnlistenFn> {
  return listen<InterruptedPayload>(RecorderChannels.interrupted, (e) =>
    handler(e.payload.interrupted.framesEncoded),
  );
}
