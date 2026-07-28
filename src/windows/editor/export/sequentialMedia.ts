/**
 * Sequential export decode — the fix for export-performance-audit.md §2.
 *
 * The legacy path drives `<video>.currentTime` seeks once per exported frame,
 * which costs O(GOP length) decodes per frame (WebKit re-walks from the
 * previous keyframe every time). This module decodes **linearly** instead:
 * mediabunny's `VideoSampleSink.samplesAtTimestamps` with a monotonically
 * increasing timestamp list decodes each source packet at most once, in
 * hardware, while preserving the exact frame-selection semantics of a precise
 * seek (the last sample with start ≤ t — see the quality contract in the
 * audit §6.5).
 *
 * Sources are read straight off `media://` with bounded ranged fetches, so
 * the recording is never materialized into a multi-GB Blob first (audit §5.1)
 * — and because pixels arrive via WebCodecs rather than a media element, the
 * canvas is never tainted, which the GIF path relies on.
 *
 * Every failure mode at init (unsupported container, undecodable codec, no
 * WebCodecs) resolves to `null` so callers fall back to the legacy seek path —
 * output pixels are identical either way, only the decode strategy differs.
 */

import { ALL_FORMATS, CustomSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";

import type { CompositorMedia } from "./exportCompositor";
import { createFrameSurface, type FrameSurface, type FrameSurfaceMode } from "./frameSurface";

/**
 * A mediabunny source over `media://` using **bounded** Range reads only.
 *
 * Mediabunny's stock `UrlSource` issues open-ended `bytes=N-` requests and
 * aborts the stream once satisfied — fine against a real HTTP server, but
 * Tauri custom-protocol responses aren't streamed: the Rust handler would
 * materialize (and IPC-transfer) everything from N to EOF per request. Exact
 * `bytes=start-end` reads keep both sides bounded to what's actually needed.
 */
export function rangedMediaSource(url: string): CustomSource {
  const fetchRange = async (start: number, endInclusive: number): Promise<Response> => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${endInclusive}` },
    });
    if (!res.ok) throw new Error(`media read failed (${res.status})`);
    return res;
  };

  return new CustomSource({
    getSize: async () => {
      const res = await fetchRange(0, 0);
      const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
      if (!Number.isFinite(total) || total <= 0) {
        throw new Error("media size unavailable");
      }
      return total;
    },
    // `end` is exclusive (Blob.slice semantics); Range headers are inclusive.
    read: async (start, end) => {
      const res = await fetchRange(start, end - 1);
      return new Uint8Array(await res.arrayBuffer());
    },
    // Local file behind IPC → page-aligned bidirectional prefetch fits best.
    prefetchProfile: "fileSystem",
  });
}

/** One decodable track: a frame surface + a per-frame sample iterator factory. */
type SequentialTrack = {
  surface: FrameSurface;
  begin: (frameTimes: number[]) => AsyncGenerator<VideoSample | null, void, unknown>;
  dispose: () => void;
};

export type SequentialReadOptions = {
  /**
   * Prefer handing the compositor `VideoFrame`s instead of painting each
   * sample into a canvas first. Default `"video-frame"` — Pixi uploads them
   * directly. Canvas paint remains only for rotated samples.
   */
  mode?: FrameSurfaceMode;
};

export type SequentialReader = {
  /** Advance every track to the next planned timestamp. */
  nextFrame: () => Promise<void>;
};

export type SequentialMedia = {
  /** Drop-in `CompositorMedia` — surfaces satisfy what the compositor reads. */
  media: CompositorMedia;
  /**
   * Start reading. `frameTimes` must be ascending source times, one per output
   * frame; each `nextFrame()` advances every track to the next entry.
   */
  begin: (frameTimes: number[], options?: SequentialReadOptions) => SequentialReader;
};

/** Decodes kept ahead of the current export frame (mediabunny path). */
const PREFETCH_DEPTH = 2;

/**
 * Open screen (+ optional camera) for sequential decode. Returns `null` when
 * any required track can't take this path, so the caller falls back to seeks
 * for *all* tracks — mixing strategies would reintroduce per-frame seeks.
 */
export async function openSequentialMedia(
  screenUrl: string,
  cameraUrl: string | null,
): Promise<SequentialMedia | null> {
  if (typeof VideoDecoder === "undefined") return null;

  const screen = await openTrack(screenUrl).catch(() => null);
  if (!screen) return null;

  let camera: Awaited<ReturnType<typeof openTrack>> = null;
  if (cameraUrl) {
    camera = await openTrack(cameraUrl).catch(() => null);
    if (!camera) {
      screen.track.dispose();
      return null;
    }
  }

  const tracks: SequentialTrack[] = [
    screen.track,
    ...(camera ? [camera.track] : []),
  ];

  const media: CompositorMedia = {
    video: screen.track.surface.element,
    camera: camera?.track.surface.element ?? null,
    duration: screen.duration,
    dispose: () => {
      for (const t of tracks) t.dispose();
    },
  };

  return {
    media,
    begin: (frameTimes, options) => {
      const mode = options?.mode ?? "video-frame";
      const readers = tracks.map((track) => {
        track.surface.setMode(mode);
        const iterator = track.begin(frameTimes);
        // Prefetch depth 2: while frame N composites/encodes, N+1 and N+2 are
        // already decoding. Caps memory at two extra samples per track.
        const pending: Promise<IteratorResult<VideoSample | null, void>>[] = [];
        const enqueue = () => {
          const next = iterator.next();
          swallow(next);
          pending.push(next);
        };
        for (let i = 0; i < PREFETCH_DEPTH; i += 1) enqueue();

        return async () => {
          const result = await pending.shift()!;
          enqueue();
          // `null` (t precedes the track's first sample) or exhaustion keeps
          // the previous frame on the surface — the same hold-last behavior a
          // clamped element seek has.
          if (!result.done && result.value) track.surface.push(result.value);
        };
      });

      return {
        nextFrame: async () => {
          await Promise.all(readers.map((advance) => advance()));
        },
      };
    },
  };
}

/**
 * Keep a prefetched promise from surfacing as an unhandled rejection when the
 * export is torn down before it is awaited. The original promise still rejects
 * for whoever awaits it.
 */
function swallow(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

async function openTrack(
  url: string,
): Promise<{ track: SequentialTrack; duration: number } | null> {
  const input = new Input({ source: rangedMediaSource(url), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) {
      input.dispose();
      return null;
    }
    const duration = await input.computeDuration();
    const sink = new VideoSampleSink(videoTrack);
    const surface = createFrameSurface(duration);

    return {
      duration,
      track: {
        surface,
        begin: (frameTimes) => sink.samplesAtTimestamps(frameTimes),
        dispose: () => {
          surface.dispose();
          input.dispose();
        },
      },
    };
  } catch (e) {
    input.dispose();
    throw e;
  }
}
