/**
 * Preview column matching the web editor: centered canvas + playback bar,
 * then a full-bleed timeline docked to the bottom of the column.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  computeCursorLoopReturn,
  findSegmentIndexAtTime,
  getNextPlayableTime,
  preloadCursorAssets,
} from "@/engine";
import { useEditorStore } from "../store";
import { resolveZoomReactiveState } from "../render/renderFrame";
import {
  createFrameCompositor,
  type FrameCompositor,
  type FrameCompositorSurface,
} from "../render/createFrameCompositor";
import { trackVideoFrames } from "../render/videoFrameTrack";
import { useStageDimensions } from "../lib/useStageDimensions";
import { getZoomPanAtTime } from "../lib/zoomCache";
import {
  isEditorTypingTarget,
  presentableVideoTime,
  primePausedVideoFrame,
  publishPlaybackTime,
  toggleEditorPlayback,
} from "../lib/playback";
import { PlaybackControls } from "./PlaybackControls";
import { useSameOriginMediaUrl } from "../lib/useSameOriginMediaUrl";
import {
  MEDIA_DIRECT_PREVIEW_LIMIT,
  probeMediaSize,
} from "../lib/mediaBlobUrl";
import { useI18n } from "@/lib/settings";

/** Pace the play loop to presented video samples when RVFC exists; else rAF. */
function playFrameScheduler(video: HTMLVideoElement | null): {
  request: (cb: () => void) => number;
  cancel: (id: number) => void;
} {
  if (video && typeof video.requestVideoFrameCallback === "function") {
    return {
      request: (cb) => video.requestVideoFrameCallback(() => cb()),
      cancel: (id) => video.cancelVideoFrameCallback(id),
    };
  }
  return {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  };
}

/** The hidden <video> lives here but is owned by the parent so the full-width
 *  timeline (a sibling, not a child) can seek it too. */
export function PreviewStage({
  videoRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  /** Requests a single paused-state repaint; assigned by the render effect. */
  const requestPaintRef = useRef<() => void>(() => {});
  const compositorRef = useRef<FrameCompositor | null>(null);

  const { t: translate } = useI18n();
  const screenUrl = useEditorStore((s) => s.screenUrl);
  const proxyUrl = useEditorStore((s) => s.proxyUrl);
  const proxyPending = useEditorStore((s) => s.proxyPending);
  const cameraUrl = useEditorStore((s) => s.cameraUrl);

  /**
   * `null` until probed. `true` = the original is small enough to preview
   * directly while the proxy transcodes; `false` = wait for the proxy instead.
   */
  const [originalIsSmall, setOriginalIsSmall] = useState<boolean | null>(null);

  useEffect(() => {
    if (!screenUrl) {
      setOriginalIsSmall(null);
      return;
    }
    const ac = new AbortController();
    setOriginalIsSmall(null);
    void probeMediaSize(screenUrl, { signal: ac.signal })
      // An unreported size must not block the preview — fall back to opening
      // against the original, which is what happened before this gate existed.
      .then((size) => {
        if (!ac.signal.aborted) {
          setOriginalIsSmall(size === null || size <= MEDIA_DIRECT_PREVIEW_LIMIT);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) setOriginalIsSmall(true);
      });
    return () => ac.abort();
  }, [screenUrl]);

  // Scrub/play against the lightweight proxy when it exists; the exporter still
  // reads the original (`screenUrl`) directly. While a transcode is running,
  // only fall back to the original when it is small enough to copy into the
  // heap — on a long recording that copy is multi-gigabyte, races the transcode
  // for the same file, and is thrown away the moment the proxy lands.
  // `=== false` (not `!`) so an in-flight probe keeps the old behaviour.
  const waitingForProxy = proxyPending && originalIsSmall === false;
  const previewUrl = proxyUrl ?? (waitingForProxy ? null : screenUrl);
  // media:// is cross-origin on WKWebView — GPU upload throws SecurityError.
  // Same-origin blob: URLs are required for compositing local media.
  const playbackUrl = useSameOriginMediaUrl(previewUrl);
  const playbackCameraUrl = useSameOriginMediaUrl(cameraUrl);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const muted = useEditorStore((s) => s.muted);
  const volume = useEditorStore((s) => s.volume);

  const stage = useStageDimensions();
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    preloadCursorAssets();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let loopRaf = 0;
    let loopCancel: ((id: number) => void) | null = null;
    let paintRaf = 0;
    let playing = useEditorStore.getState().isPlaying;
    let compositor: FrameCompositor | null = null;
    let remounting = false;
    let recoverAttempts = 0;

    // Preview never asks for an offscreen surface (that's an export-only
    // optimization), so the compositor always hands back a DOM canvas here.
    const mountCanvas = (canvas: FrameCompositorSurface) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("preview compositor produced a non-DOM surface");
      }
      canvas.className = "block h-full w-full";
      host.replaceChildren(canvas);
    };

    const attachCompositor = (comp: FrameCompositor) => {
      const { width, height } = stageRef.current;
      comp.resize(width, height);
      compositor = comp;
      compositorRef.current = comp;
      mountCanvas(comp.canvas);
      console.info(`[preview] compositor backend=${comp.backend}`);
    };

    const compositorOptions = () => ({
      width: stageRef.current.width,
      height: stageRef.current.height,
      preserveDrawingBuffer: false,
      // Per-upload mip regen dominates preview compose; bilinear is fine at
      // stage size (export already runs without mipmaps).
      mipmaps: false,
      // WebGL first for preview: WebGPU on WKWebView throws
      // `program.layout[groupIndex]` null and blacks the stage.
      gpuPreference: ["webgl", "webgpu"] as const,
    });

    const recoverCompositor = () => {
      if (disposed || remounting || recoverAttempts >= 3) return;
      remounting = true;
      recoverAttempts += 1;
      const dead = compositor;
      compositor = null;
      compositorRef.current = null;
      dead?.dispose();
      void createFrameCompositor(compositorOptions())
        .then((comp) => {
          remounting = false;
          if (disposed) {
            comp.dispose();
            return;
          }
          attachCompositor(comp);
          // Force a paint even if a prior rAF was coalesced away during remount.
          if (paintRaf) cancelAnimationFrame(paintRaf);
          paintRaf = requestAnimationFrame(() => {
            paintRaf = 0;
            paint();
          });
        })
        .catch((err) => {
          remounting = false;
          console.error("[preview] compositor recover failed", err);
        });
    };

    const paint = () => {
      const comp = compositor;
      if (!comp) return;
      const store = useEditorStore.getState();
      const {
        sourceAspect,
        backgroundImage,
        look,
        zoomFragments,
        recordingMetadata,
        currentTime,
        isPlaying: nowPlaying,
        screenContentCrop: crop,
        captions,
        captionSettings,
        aspectRatioPresetId,
        backgroundType,
        sourceVideoSize,
      } = store;

      const video = videoRef.current;
      const camera = cameraRef.current;
      const t = video?.currentTime ?? currentTime;

      if (camera && Number.isFinite(camera.duration) && camera.duration > 0) {
        if (Math.abs(camera.currentTime - t) > 0.12) {
          camera.currentTime = Math.min(
            t,
            Math.max(0, camera.duration - 0.001),
          );
        }
        if (nowPlaying && camera.paused)
          void camera.play().catch(() => undefined);
        if (!nowPlaying && !camera.paused) camera.pause();
      }

      const zoom = getZoomPanAtTime(zoomFragments, recordingMetadata, crop, t);
      const active =
        zoomFragments.find((f) => t >= f.start && t <= f.end) ?? null;

      try {
        comp.compose(
          {
            // The compositor owns its bitmap; `width`/`height` are the
            // composition reference the look values are calibrated against.
            width: stageRef.current.width,
            height: stageRef.current.height,
            video,
            cameraVideo: camera,
            sourceAspect,
            background: backgroundImage,
            look,
            aspectRatioPresetId,
            backgroundType,
            sourceVideoSize,
            // Baked keyframes go straight to the camera: they are already
            // recording-rect NDC, enveloped and clamped.
            zoomScale: zoom.scale,
            zoomFocus: { x: zoom.x, y: zoom.y },
            ...resolveZoomReactiveState(active, t),
            screenContentCrop: crop,
            cursorTime: t,
            cursorFreeze: !nowPlaying,
            cursorSettings: store.cursorSettings,
            cursorLoopReturn: store.cursorSettings.loopCursor
              ? computeCursorLoopReturn(store.segments, store.duration)
              : null,
            recordingMetadata,
            faceCam: store.faceCam,
          },
          {
            captions,
            settings: captionSettings,
            timeMs: t * 1000,
          },
        );
        recoverAttempts = 0;
      } catch (e) {
        // GPU context can be poisoned (e.g. old shadow-canvas resize bug).
        // Remount once so the user is not stuck on a black stage.
        console.error("[preview] compose failed — remounting compositor", e);
        recoverCompositor();
      }
    };

    const advancePlayback = () => {
      const { segments, duration } = useEditorStore.getState();
      const video = videoRef.current;
      if (!video || segments.length === 0) return;
      if (findSegmentIndexAtTime(segments, video.currentTime) >= 0) return;

      const next = getNextPlayableTime(segments, video.currentTime);
      if (next != null && next < duration) {
        video.currentTime = next;
        publishPlaybackTime(next, { force: true });
      } else {
        video.pause();
        useEditorStore.getState().setPlaying(false);
        const last = segments[segments.length - 1];
        if (last) {
          video.currentTime = last.end;
          publishPlaybackTime(last.end, { force: true });
        }
      }
    };

    const loop = () => {
      advancePlayback();
      paint();
      if (!playing) {
        loopRaf = 0;
        loopCancel = null;
        return;
      }
      // Re-resolve each tick: the element is stable, but RVFC may appear only
      // after the media has a source.
      const sched = playFrameScheduler(videoRef.current);
      loopCancel = sched.cancel;
      loopRaf = sched.request(loop);
    };

    const startLoop = () => {
      if (loopRaf) return;
      if (paintRaf) {
        cancelAnimationFrame(paintRaf);
        paintRaf = 0;
      }
      const sched = playFrameScheduler(videoRef.current);
      loopCancel = sched.cancel;
      loopRaf = sched.request(loop);
    };

    const stopLoop = () => {
      if (!loopRaf) return;
      (loopCancel ?? cancelAnimationFrame)(loopRaf);
      loopRaf = 0;
      loopCancel = null;
    };

    const requestPaint = () => {
      if (loopRaf || paintRaf) return;
      paintRaf = requestAnimationFrame(() => {
        paintRaf = 0;
        paint();
      });
    };
    requestPaintRef.current = requestPaint;

    void createFrameCompositor(compositorOptions())
      .then((comp) => {
        if (disposed) {
          comp.dispose();
          return;
        }
        attachCompositor(comp);
        // Pixi VideoSource used to autoplay; belt-and-suspenders if anything
        // else nudged the element while we were mounting.
        const v = videoRef.current;
        if (!playing && v && !v.paused) v.pause();
        if (playing) startLoop();
        else requestPaint();
      })
      .catch((e) => {
        console.error("[preview] Pixi compositor init failed", e);
      });

    /**
     * The store fields `paint()` actually reads. Every other mutation —
     * inspector panel, selection, volume, and above all the ~100 export
     * progress writes — cannot change a pixel, and repainting for them costs a
     * full video texture upload plus a scene render (see plans/018).
     *
     * Reference equality is the right test: the store replaces these objects
     * on change rather than mutating them, so a deep compare would be pure
     * cost. Anything added to `paint()`'s reads MUST be added here too.
     */
    type FramePaintState = Parameters<
      Parameters<typeof useEditorStore.subscribe>[0]
    >[0];
    const framePaintInputsChanged = (
      next: FramePaintState,
      prev: FramePaintState,
    ): boolean =>
      next.sourceAspect !== prev.sourceAspect ||
      next.backgroundImage !== prev.backgroundImage ||
      next.look !== prev.look ||
      next.zoomFragments !== prev.zoomFragments ||
      next.recordingMetadata !== prev.recordingMetadata ||
      next.currentTime !== prev.currentTime ||
      next.isPlaying !== prev.isPlaying ||
      next.screenContentCrop !== prev.screenContentCrop ||
      next.captions !== prev.captions ||
      next.captionSettings !== prev.captionSettings ||
      next.cursorSettings !== prev.cursorSettings ||
      next.segments !== prev.segments ||
      next.duration !== prev.duration ||
      next.faceCam !== prev.faceCam;

    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      if (state.isPlaying !== playing) {
        playing = state.isPlaying;
        if (playing) startLoop();
        else {
          stopLoop();
          const v = videoRef.current;
          if (v) publishPlaybackTime(v.currentTime, { force: true });
          requestPaint();
        }
        return;
      }
      if (!playing && framePaintInputsChanged(state, prev)) requestPaint();
    });

    return () => {
      disposed = true;
      stopLoop();
      if (paintRaf) cancelAnimationFrame(paintRaf);
      unsubscribe();
      requestPaintRef.current = () => {};
      compositor?.dispose();
      compositor = null;
      compositorRef.current = null;
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const comp = compositorRef.current;
    if (!comp) return;
    comp.resize(stage.width, stage.height);
    requestPaintRef.current();
  }, [stage.width, stage.height]);

  // Re-binds whenever the element is replaced (the `key` below remounts it on
  // every source change), so frame tracking is never left on a dead element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stopTrack = trackVideoFrames(video, () => requestPaintRef.current());
    const onFrameReady = () => requestPaintRef.current();
    video.addEventListener("seeked", onFrameReady);
    video.addEventListener("loadeddata", onFrameReady);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      void primePausedVideoFrame(video).then(onFrameReady);
    }
    return () => {
      stopTrack();
      video.removeEventListener("seeked", onFrameReady);
      video.removeEventListener("loadeddata", onFrameReady);
    };
  }, [playbackUrl, videoRef]);

  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const stopTrack = trackVideoFrames(camera, () => requestPaintRef.current());
    const onFrameReady = () => requestPaintRef.current();
    camera.addEventListener("seeked", onFrameReady);
    camera.addEventListener("loadeddata", onFrameReady);
    return () => {
      stopTrack();
      camera.removeEventListener("seeked", onFrameReady);
      camera.removeEventListener("loadeddata", onFrameReady);
    };
  }, [playbackCameraUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying)
      video.play().catch(() => useEditorStore.getState().setPlaying(false));
    else video.pause();
  }, [isPlaying, playbackUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = Math.max(0, Math.min(1, volume / 100));
  }, [muted, volume]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditorTypingTarget()) return;
      if (e.code !== "Space" && e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      toggleEditorPlayback(videoRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [videoRef]);

  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      if (state.isPlaying) return;
      if (Math.abs(state.currentTime - prev.currentTime) < 1e-3) return;
      const video = videoRef.current;
      if (video && Math.abs(video.currentTime - state.currentTime) > 0.04) {
        video.currentTime = presentableVideoTime(
          state.currentTime,
          video.duration,
        );
      }
      const camera = cameraRef.current;
      if (camera && Math.abs(camera.currentTime - state.currentTime) > 0.04) {
        camera.currentTime = presentableVideoTime(
          state.currentTime,
          camera.duration,
        );
      }
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden p-4">
      <div className="@container-size relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative overflow-hidden rounded-xl border border-border bg-black"
            style={{
              aspectRatio: `${stage.width} / ${stage.height}`,
              width: `min(100cqw, calc(100cqh * ${stage.width} / ${stage.height}))`,
              maxHeight: "100cqh",
            }}
          >
            <div ref={hostRef} className="block h-full w-full" />
            {playbackUrl === null && proxyPending ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white/80">
                {translate("preview.preparing")}
              </div>
            ) : null}
            <video
              ref={videoRef}
              // A fresh element per source, exactly like the face cam below.
              // Re-pointing a WKWebView media element that has already loaded a
              // blob at a second blob errors with MEDIA_ERR_SRC_NOT_SUPPORTED
              // *after* it reports dimensions — which is why the recording shows
              // for a frame and then vanishes the moment the preview proxy
              // finishes transcoding and swaps in.
              key={playbackUrl ?? "no-source"}
              src={playbackUrl ?? undefined}
              className="hidden"
              // Blob URLs are same-origin; leave crossOrigin unset (CORS mode
              // on media:// is what taints WKWebView GPU uploads).
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                useEditorStore
                  .getState()
                  .onVideoLoaded(v.videoWidth, v.videoHeight, v.duration);
                const { currentTime, isPlaying: playing } =
                  useEditorStore.getState();
                if (
                  currentTime > 0.01 &&
                  Math.abs(v.currentTime - currentTime) > 0.05
                ) {
                  v.currentTime = presentableVideoTime(currentTime, v.duration);
                }
                if (playing) void v.play().catch(() => undefined);
              }}
              onLoadedData={(e) => {
                if (useEditorStore.getState().isPlaying) return;
                void primePausedVideoFrame(e.currentTarget).then(() =>
                  requestPaintRef.current(),
                );
              }}
              onTimeUpdate={(e) =>
                publishPlaybackTime(e.currentTarget.currentTime)
              }
              onEnded={() => useEditorStore.getState().setPlaying(false)}
              // A dead source is otherwise invisible: the compositor just hides
              // the screen layer and the stage reads as a plain black preview.
              onError={(e) =>
                console.error(
                  "[preview] screen media failed to load",
                  e.currentTarget.error?.code,
                  e.currentTarget.error?.message,
                )
              }
            />
            {playbackCameraUrl ? (
              <video
                ref={cameraRef}
                key={playbackCameraUrl}
                src={playbackCameraUrl}
                className="hidden"
                muted
                playsInline
                preload="auto"
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="w-full shrink-0">
        <PlaybackControls videoRef={videoRef} />
      </div>
    </div>
  );
}
