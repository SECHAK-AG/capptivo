/**
 * Sequential export decode — linear WebCodecs decode instead of per-frame seeks.
 * Falls back to `null` so callers use the legacy seek path with identical output.
 */

import { ALL_FORMATS, CustomSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";

import type { CompositorMedia } from "./exportCompositor";
import { faceCamMediaTime, type FaceCamTrack } from "../lib/faceCamSync";
import { createFrameSurface, type FrameSurface, type FrameSurfaceMode } from "./frameSurface";

/** Bounded Range reads for `media://` — avoids materializing multi-GB responses. */
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
    // `end` is exclusive; Range headers are inclusive.
    read: async (start, end) => {
      const res = await fetchRange(start, end - 1);
      return new Uint8Array(await res.arrayBuffer());
    },
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
  /** `"video-frame"` (default) uploads directly; canvas paint for rotated samples. */
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

/** Open screen (+ camera) for sequential decode; `null` → seek fallback for all tracks. */
export async function openSequentialMedia(
  screenUrl: string,
  faceCam: FaceCamTrack,
): Promise<SequentialMedia | null> {
  if (typeof VideoDecoder === "undefined") return null;

  const screen = await openTrack(screenUrl).catch(() => null);
  if (!screen) return null;

  let camera: Awaited<ReturnType<typeof openTrack>> = null;
  if (faceCam.url) {
    camera = await openTrack(faceCam.url).catch(() => null);
    if (!camera) {
      screen.track.dispose();
      return null;
    }
  }

  const tracks: SequentialTrack[] = [
    screen.track,
    ...(camera ? [camera.track] : []),
  ];
  /**
   * Timeline times are screen times. The face-cam decodes its own file, so its
   * plan is the same instants mapped through the recorded start offset — the
   * mapping the preview uses, so the export matches what the user scrubbed.
   */
  const planFor = (track: SequentialTrack, frameTimes: number[]): number[] => {
    if (!camera || track !== camera.track) return frameTimes;
    const camDuration = camera.duration;
    return frameTimes.map(
      (t) => faceCamMediaTime(t, faceCam.offsetMs, camDuration) ?? 0,
    );
  };

  const media: CompositorMedia = {
    video: screen.track.surface.element,
    camera: camera?.track.surface.element ?? null,
    duration: screen.duration,
    cameraOffsetMs: faceCam.offsetMs,
    cameraDuration: camera?.duration ?? 0,
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
        const iterator = track.begin(planFor(track, frameTimes));
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

/** Swallow prefetch rejections on export teardown. */
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
