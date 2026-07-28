/**
 * Typed listeners for the `recorder://…` events emitted by Rust. The frontend
 * store subscribes to these; Rust is the source of truth for recorder state (§6).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecorderState } from "./types";

export const RecorderChannels = {
  stateChanged: "recorder://state-changed",
  elapsed: "recorder://elapsed",
  level: "recorder://level",
  error: "recorder://error",
} as const;

// Rust emits the serialized `RecorderEvent` enum, externally tagged with the
// variant name in camelCase (`#[serde(rename_all = "camelCase")]`):
// `{ stateChanged: { state } }`, `{ elapsed: { seconds } }`, etc.
type StateChangedPayload = { stateChanged: { state: RecorderState } };
type ElapsedPayload = { elapsed: { seconds: number } };
type LevelPayload = { level: { micDb: number } };
type ErrorPayload = { error: { message: string; fatal: boolean } };

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
