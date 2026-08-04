/**
 * Prove the Annex-B H.264 encoder actually works on *this* machine.
 *
 * `VideoEncoder.isConfigSupported()` is not trustworthy on WebView2: it reports
 * `supported: true` for hardware H.264 configurations that then accept frames
 * and never emit a single chunk. Every "export stuck at N%" report traces back
 * to believing that answer and discovering the truth 23 frames into a real
 * export, at which point there is nothing to do but hang.
 *
 * So the probe encodes a few real frames and requires real bytes back, with a
 * deadline. A dead configuration costs a few hundred milliseconds to rule out
 * instead of wedging the export, which is what makes it safe to *try* hardware
 * everywhere rather than blanket-banning it per platform.
 *
 * The whole probe is bounded by {@link ANNEX_B_PROBE_BUDGET_MS}; when the budget
 * runs out the caller falls back to the RGBA→ffmpeg route, which needs no
 * WebCodecs at all.
 */

import { annexBHardwareProbeOrder, type AnnexBHwMode } from "./exportRouting";
import { ANNEX_B_CODEC, isAnnexBStartCode } from "./h264Keyframe";
import { withDeadline } from "./exportStall";

/** Try High@L4.2 first (1080p60), then High@L4.0. */
const ANNEX_B_CODEC_CANDIDATES = [ANNEX_B_CODEC, "avc1.640028"] as const;

/** Frames pushed through a candidate before believing it. */
const PROBE_FRAMES = 3;

/** One candidate's grace period to emit its first chunk. */
export const ANNEX_B_PROBE_TIMEOUT_MS = 4_000;

/** Total time all candidates together may burn before we give up on Annex-B. */
export const ANNEX_B_PROBE_BUDGET_MS = 12_000;

type LatencyMode = NonNullable<VideoEncoderConfig["latencyMode"]>;

export type AnnexBEncodeTuning = {
  codec: string;
  hardwareAcceleration: AnnexBHwMode;
  latencyMode: LatencyMode;
};

function buildConfig(
  tuning: AnnexBEncodeTuning,
  width: number,
  height: number,
  bitrate: number,
  fps: number,
): VideoEncoderConfig {
  return {
    codec: tuning.codec,
    width,
    height,
    bitrate,
    framerate: fps,
    bitrateMode: "variable",
    latencyMode: tuning.latencyMode,
    hardwareAcceleration: tuning.hardwareAcceleration,
    avc: { format: "annexb" },
  };
}

/** A throwaway surface to encode from. Offscreen when available. */
function createProbeSurface(
  width: number,
  height: number,
): { surface: CanvasImageSource; dispose: () => void } | null {
  const paint = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => {
    // Not a flat fill: a uniform frame can encode to almost nothing, and we want
    // the probe to exercise the same path a real frame takes.
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#000000");
    gradient.addColorStop(1, "#ffffff");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  };

  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      paint(ctx);
      return { surface: canvas, dispose: () => undefined };
    }
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  paint(ctx);
  return {
    surface: canvas,
    dispose: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/**
 * Encode {@link PROBE_FRAMES} frames and require Annex-B bytes back in time.
 *
 * Resolves with the failure reason rather than throwing: a candidate failing is
 * the expected case on at least one platform, not an error.
 */
async function verifyEncoder(
  surface: CanvasImageSource,
  tuning: AnnexBEncodeTuning,
  width: number,
  height: number,
  bitrate: number,
  fps: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let resolveFirstChunk: (chunk: EncodedVideoChunk) => void = () => undefined;
  let rejectFirstChunk: (e: Error) => void = () => undefined;
  const firstChunk = new Promise<EncodedVideoChunk>((resolve, reject) => {
    resolveFirstChunk = resolve;
    rejectFirstChunk = reject;
  });
  // The encoder reports fatal errors out-of-band; without this the deadline
  // would be the only thing that ever notices, wasting the full timeout.
  const encoder = new VideoEncoder({
    output: (chunk) => resolveFirstChunk(chunk),
    error: (e) => rejectFirstChunk(e instanceof Error ? e : new Error(String(e))),
  });

  const frameDurationUs = Math.round(1_000_000 / Math.max(1, fps));
  try {
    encoder.configure(buildConfig(tuning, width, height, bitrate, fps));
    for (let i = 0; i < PROBE_FRAMES; i++) {
      const frame = new VideoFrame(surface, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      try {
        encoder.encode(frame, { keyFrame: i === 0 });
      } finally {
        frame.close();
      }
    }

    const chunk = await withDeadline(
      firstChunk,
      ANNEX_B_PROBE_TIMEOUT_MS,
      `annex-b probe (${tuning.hardwareAcceleration}/${tuning.latencyMode})`,
    );
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    if (!isAnnexBStartCode(bytes)) {
      // Emitting AVCC here would silently produce an unplayable MP4 downstream,
      // because ffmpeg is told to demux `-f h264`.
      return { ok: false, reason: "encoder emitted AVCC, not Annex-B" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch {
      /* already torn down */
    }
  }
}

/**
 * The fastest Annex-B configuration this machine can actually deliver, or
 * `null` when none can (→ caller uses the RGBA→ffmpeg route).
 */
export async function probeAnnexBConfig(
  width: number,
  height: number,
  bitrate: number,
  fps: number,
  options: { windows: boolean; now?: () => number },
): Promise<AnnexBEncodeTuning | null> {
  if (typeof VideoEncoder === "undefined" || !VideoEncoder.isConfigSupported) {
    return null;
  }
  // WebCodecs H.264 requires even dimensions.
  if (width % 2 !== 0 || height % 2 !== 0) return null;

  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const hardwareModes = annexBHardwareProbeOrder(options.windows);
  const latencyModes: LatencyMode[] = ["realtime", "quality"];
  const rejected: string[] = [];

  // Allocated at most once, and only if some candidate gets far enough to need
  // it — a full-resolution canvas per candidate would be pure waste.
  let probe: ReturnType<typeof createProbeSurface> = null;

  try {
    for (const hardwareAcceleration of hardwareModes) {
      for (const codec of ANNEX_B_CODEC_CANDIDATES) {
        for (const latencyMode of latencyModes) {
          if (now() - startedAt >= ANNEX_B_PROBE_BUDGET_MS) {
            console.warn(
              `[export] Annex-B probe budget exhausted; using RGBA→ffmpeg (${rejected.join("; ")})`,
            );
            return null;
          }

          const tuning: AnnexBEncodeTuning = {
            codec,
            hardwareAcceleration,
            latencyMode,
          };
          const label = `${codec}/${hardwareAcceleration}/${latencyMode}`;

          // Cheap gate only — a `true` here is a claim, not evidence.
          const declared = await VideoEncoder.isConfigSupported(
            buildConfig(tuning, width, height, bitrate, fps),
          )
            .then(({ supported }) => supported === true)
            .catch(() => false);
          if (!declared) continue;

          probe ??= createProbeSurface(width, height);
          if (!probe) {
            console.warn("[export] no 2d canvas for Annex-B probe");
            return null;
          }

          const verdict = await verifyEncoder(
            probe.surface,
            tuning,
            width,
            height,
            bitrate,
            fps,
          );
          if (verdict.ok) {
            console.info(`[export] Annex-B verified: ${label}`);
            return tuning;
          }
          rejected.push(`${label}: ${verdict.reason}`);
          console.warn(`[export] Annex-B rejected ${label} — ${verdict.reason}`);
        }
      }
    }
  } finally {
    probe?.dispose();
  }

  if (rejected.length > 0) {
    console.warn(
      `[export] no working Annex-B config; using RGBA→ffmpeg (${rejected.join("; ")})`,
    );
  }
  return null;
}
