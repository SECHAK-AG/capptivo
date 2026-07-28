/**
 * GPU frame compositor (WebGL / WebGPU) built on Pixi.
 *
 * Preview prefers WebGL: WKWebView's WebGPU path is brittle
 * with video + stencil masks and throws `program.layout[groupIndex]` null,
 * leaving a black stage. Same-origin `blob:` media (see `mediaBlobUrl.ts`)
 * makes WebGL texture uploads safe. Export may still prefer WebGPU.
 *
 * All composition *math* still comes from `@/engine`. What differs from a
 * naive full-frame repaint is where the pixels are put together: the scene
 * graph is persistent and every layer is cached behind a content key, so a
 * steady-state frame costs one video texture upload plus a handful of quads.
 *
 * The layers, and what actually changes per frame:
 *
 * - background   — repainted only when the image / blur / darkness change
 * - shadows      — baked sprites, re-baked only when rect or intensity moves
 * - screen video — texture upload only when the presented sample changes
 *                  (`VideoFrame` identity on export; RVFC stamp on preview)
 * - cursor       — Pixi sprites under the camera (tip = unzoomed recording NDC)
 * - face cam     — upload only when the camera sample changes
 * - captions     — repainted only when the karaoke highlight moves
 *
 * The first cut of this migration repainted and re-uploaded three stage-sized
 * RGBA canvases (background, cursor, captions) every frame — roughly 24 MB of
 * bus traffic per 1080p frame. Keep the keys honest.
 */

import {
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  autoDetectRenderer,
  type Renderer,
} from "pixi.js";

import {
  CAMERA_IDENTITY,
  computeCameraTransform,
  contentRectPixelsFromCrop,
  drawBackgroundLayer,
  faceCamShadowPasses,
  getCompositionLayout,
  renderRoundedRectShadowSprite,
  resolveCursorOverlay,
  resolveFaceCamLayout,
  type CameraTransform,
} from "@/engine";
import { captionFrameKey, drawCaptions } from "@/captions/drawCaptions";
import {
  recordingShadowPasses,
  resolveRecordingLayoutParams,
} from "../lib/composition";
import type { LookState, RenderFrameInputs } from "./renderFrame";
import type {
  FrameCompositor,
  FrameCompositorCaptions,
  FrameCompositorOptions,
  FrameCompositorSurface,
} from "./frameCompositor";
import { ComposeProfiler } from "./composeProfiler";
import { CanvasLayer } from "./pixi/canvasLayer";
import { OutputSurface } from "./pixi/outputSurface";
import { PixiCursorOverlay } from "./pixi/pixiCursor";
import { RoundedMask } from "./pixi/roundedMask";
import { ShadowLayer } from "./pixi/shadowLayer";
import { SourceTexture } from "./pixi/sourceTexture";
import { decodedImageFor } from "./decodedFrame";

type Rect = { x: number; y: number; width: number; height: number };

/** Reused so the per-frame path allocates nothing the GC has to chase. */
const scratchCrop = new Rectangle();

export async function createPixiFrameCompositor(
  options: FrameCompositorOptions,
): Promise<FrameCompositor> {
  let width = options.width;
  let height = options.height;
  let outputWidth = options.outputWidth ?? width;
  let outputHeight = options.outputHeight ?? height;

  const profiler = new ComposeProfiler(options.profile === true);
  const { renderer, offscreen } = await createRenderer(
    options,
    outputWidth,
    outputHeight,
  );
  const pixiCanvas = renderer.canvas as unknown as FrameCompositorSurface;
  const output = new OutputSurface(
    renderer,
    width,
    height,
    outputWidth,
    outputHeight,
  );
  const stageLongEdge = Math.max(width, height);
  // Opt-in: mip regen on every upload is usually pure cost for preview/export.
  const mipmaps = options.mipmaps === true;

  // --- scene graph -------------------------------------------------------
  const stage = new Container({ label: "stage" });

  // Opaque black under everything — both the letterbox behind a zoomed camera
  // and the fill Canvas2D paints when there is no background image. A unit rect
  // scaled to the stage, so resizing never re-tessellates it.
  const backdrop = new Graphics().rect(0, 0, 1, 1).fill(0x000000);
  backdrop.scale.set(width, height);

  const background = new CanvasLayer("background");
  const recordingShadow = new ShadowLayer("recording-shadow");
  const cursorOverlay = new PixiCursorOverlay();
  const captionsLayer = new CanvasLayer("captions");

  const screenTexture = new SourceTexture("screen", stageLongEdge, { mipmaps });
  const screenSprite = new Sprite();
  const screenMask = new RoundedMask();
  screenSprite.mask = screenMask.graphics;

  /**
   * Everything anchored to the recording, and the only thing zoom moves. The
   * cursor lives here rather than as a stage overlay because it marks a point
   * *on* the recording — sharing the container is what makes it impossible for
   * the two to disagree about where that point is. Zoom is a transform on this
   * parent, never a per-layer calculation; the background stays outside so it
   * holds still while the recording zooms over it.
   */
  const camera = new Container({ label: "camera" });

  const faceRoot = new Container({ label: "face-cam" });
  const faceShadow = new ShadowLayer("face-shadow");
  const faceTexture = new SourceTexture("camera", stageLongEdge, { mipmaps });
  const faceSprite = new Sprite();
  const faceMask = new RoundedMask();
  faceSprite.mask = faceMask.graphics;
  // Masks stay in the scene graph so their transforms resolve; Pixi excludes
  // them from the draw list itself (`StencilMask.includeInBuild = false`).
  faceRoot.addChild(faceShadow.sprite, faceSprite, faceMask.graphics);

  // Masks stay in the graph so their transforms resolve, and must sit *inside*
  // the camera or the rounded corners would not scale with the recording.
  camera.addChild(
    recordingShadow.sprite,
    screenSprite,
    screenMask.graphics,
    cursorOverlay.container,
  );
  // Background, face cam and captions stay stage overlays outside the camera —
  // the background holds still while the recording zooms into it, and a zoom
  // never scales the PiP off-frame.
  stage.addChild(
    backdrop,
    background.sprite,
    camera,
    faceRoot,
    captionsLayer.sprite,
  );

  // --- CPU readback (GIF quantization is the only pixel reader) -----------
  let readbackCanvas: HTMLCanvasElement | null = null;
  let readbackCtx: CanvasRenderingContext2D | null = null;
  if (options.cpuReadback) {
    readbackCanvas = document.createElement("canvas");
    readbackCanvas.width = outputWidth;
    readbackCanvas.height = outputHeight;
    readbackCtx = readbackCanvas.getContext("2d", { willReadFrequently: true });
    if (!readbackCtx)
      throw new Error("pixi compositor: readback context unavailable");
  }

  function resize(
    nextWidth: number,
    nextHeight: number,
    nextOutputWidth = nextWidth,
    nextOutputHeight = nextHeight,
  ): void {
    if (
      nextWidth === width &&
      nextHeight === height &&
      nextOutputWidth === outputWidth &&
      nextOutputHeight === outputHeight
    ) {
      return;
    }
    width = nextWidth;
    height = nextHeight;
    outputWidth = nextOutputWidth;
    outputHeight = nextOutputHeight;
    renderer.resize(outputWidth, outputHeight);
    output.resize(width, height, outputWidth, outputHeight);
    backdrop.scale.set(width, height);
    if (readbackCanvas) {
      readbackCanvas.width = outputWidth;
      readbackCanvas.height = outputHeight;
    }
  }

  function compose(
    inputs: RenderFrameInputs,
    captions?: FrameCompositorCaptions | null,
  ): void {
    const w = width;
    const h = height;
    const look = inputs.look;
    const zoomScale = inputs.zoomScale ?? 1;
    const zoomFocus = inputs.zoomFocus ?? { x: 0.5, y: 0.5 };
    const crop = inputs.screenContentCrop ?? null;
    const backgroundImage = inputs.background;

    profiler.begin();

    // The camera needs the recording rect, which the layout below resolves —
    // applied once `rect` is known. Reset here so a frame that never gets that
    // far (no decodable screen) cannot leave a stale zoom on the graph.
    setCameraTransform(CAMERA_IDENTITY);

    // --- background -------------------------------------------------------
    background.update({
      key: backgroundImage
        ? `${imageId(backgroundImage)}|${w}x${h}|${look.backgroundBlur}|${look.backgroundDarkness}`
        : null,
      x: 0,
      y: 0,
      width: w,
      height: h,
      draw: (ctx) =>
        drawBackgroundLayer(
          ctx,
          backgroundImage as CanvasImageSource,
          w,
          h,
          look.backgroundBlur,
          look.backgroundDarkness,
        ),
    });
    backdrop.visible = !backgroundImage;
    profiler.mark("background");

    // --- screen recording -------------------------------------------------
    // `bind` uploads only when the presented sample changes (VideoFrame
    // identity on export; RVFC stamp on preview <video>).
    const screenSize = screenTexture.bind(decodedImageFor(inputs.video));
    profiler.mark("screenUpload");

    if (screenSize) {
      const hasSelectedBackground = backgroundImage !== null;
      const hasImageBackground =
        hasSelectedBackground && (inputs.backgroundType ?? "image") === "image";
      const { sourceAspect, devicePadding: basePadding } =
        resolveRecordingLayoutParams({
          presetId: inputs.aspectRatioPresetId ?? "recording",
          sourceAspect: inputs.sourceAspect,
          sourceVideoSize: inputs.sourceVideoSize ?? {
            width: screenSize.width,
            height: screenSize.height,
          },
          hasSelectedBackground,
          hasImageBackground,
          devicePadding: look.devicePadding,
          screenContentCrop: crop,
        });
      const { video: rect } = getCompositionLayout(
        sourceAspect,
        w,
        h,
        basePadding,
      );
      const radius = Math.max(
        0,
        Math.min(look.cornerRadius, Math.min(rect.width, rect.height) / 2),
      );

      updateRecordingShadow(rect, radius, look, !!backgroundImage);
      profiler.mark("shadow");

      // The camera owns zoom now, so the texture crop is only ever the static
      // screen-content crop — one less thing that has to track the zoom.
      const content = crop
        ? contentRectPixelsFromCrop(screenSize.width, screenSize.height, crop)
        : { ox: 0, oy: 0, rw: screenSize.width, rh: screenSize.height };

      screenSprite.visible = true;
      scratchCrop.x = content.ox;
      scratchCrop.y = content.oy;
      scratchCrop.width = content.rw;
      scratchCrop.height = content.rh;
      screenSprite.texture = screenTexture.crop(scratchCrop);
      screenSprite.position.set(rect.x, rect.y);
      screenSprite.setSize(rect.width, rect.height);
      screenMask.set(rect.x, rect.y, rect.width, rect.height, radius);
      profiler.mark("screenGeometry");

      // Placed in the unzoomed rect and left there: the camera below applies
      // the zoom to the cursor and the video in the same operation.
      updateCursor(inputs, rect);
      profiler.mark("cursor");

      setCameraTransform(
        computeCameraTransform({
          stageWidth: w,
          stageHeight: h,
          videoRect: rect,
          focus: zoomFocus,
          scale: zoomScale,
        }),
      );
    } else {
      // `bind` may have released the previous GPU texture — never leave a
      // destroyed texture on a live sprite (WebGPU present then nulls out).
      screenSprite.texture = Texture.EMPTY;
      screenSprite.visible = false;
      recordingShadow.sprite.visible = false;
      cursorOverlay.hide();
    }

    updateFaceCam(inputs, w, h);
    profiler.mark("faceCam");

    // --- captions (stage overlay, above face cam; not scene-zoomed) --------
    captionsLayer.update({
      key: captions
        ? captionFrameKey(
            captions.captions,
            captions.settings,
            w,
            h,
            captions.timeMs,
          )
        : null,
      x: 0,
      y: 0,
      width: w,
      height: h,
      draw: (ctx) =>
        drawCaptions(
          ctx,
          captions!.captions,
          captions!.settings,
          w,
          h,
          captions!.timeMs,
        ),
    });
    profiler.mark("captions");

    output.present(stage);
    profiler.mark("render");

    if (readbackCtx && readbackCanvas) {
      readbackCtx.clearRect(0, 0, outputWidth, outputHeight);
      readbackCtx.drawImage(pixiCanvas as CanvasImageSource, 0, 0);
      profiler.mark("readback");
    }
  }

  function setCameraTransform(transform: CameraTransform): void {
    camera.scale.set(transform.scale);
    camera.position.set(transform.x, transform.y);
  }

  function updateRecordingShadow(
    rect: Rect,
    radius: number,
    look: LookState,
    hasBackground: boolean,
  ): void {
    const intensity = look.recordingShadowIntensity;
    if (!hasBackground || intensity <= 0) {
      recordingShadow.sprite.visible = false;
      return;
    }

    // The camera owns zoom now, so `rect` is the static device-padding layout:
    // it only changes when the look does, and the bake key already covers that.
    const shortEdge = Math.min(width, height);

    recordingShadow.update({
      key: `${rect.width}x${rect.height}|${radius}|${intensity}|${shortEdge}`,
      bake: (reuse) =>
        renderRoundedRectShadowSprite(
          reuse,
          rect.width,
          rect.height,
          radius,
          recordingShadowPasses(intensity, shortEdge),
        ),
      x: rect.x,
      y: rect.y,
      scaleX: 1,
      scaleY: 1,
    });
  }

  function updateCursor(inputs: RenderFrameInputs, rect: Rect): void {
    const settings = inputs.cursorSettings;
    if (inputs.cursorTime == null || !settings || !inputs.recordingMetadata) {
      cursorOverlay.hide();
      return;
    }

    const frame = resolveCursorOverlay({
      time: inputs.cursorTime,
      settings,
      metadata: inputs.recordingMetadata,
      videoRect: rect,
      screenContentCrop: inputs.screenContentCrop ?? null,
      loopReturn: inputs.cursorLoopReturn ?? null,
    });
    cursorOverlay.update({
      placement: frame?.placement ?? null,
      timeSec: inputs.cursorTime,
      freeze: inputs.cursorFreeze === true,
      videoRect: rect,
      smoothness: settings.smoothness,
      sway: settings.sway,
      motionBlur: settings.motionBlur,
      clickShrink: settings.clickShrink,
      clickEffect: settings.clickEffect,
      pressIntervals: inputs.recordingMetadata.cursorPressIntervals,
    });
  }

  function updateFaceCam(
    inputs: RenderFrameInputs,
    w: number,
    h: number,
  ): void {
    const cameraSize = faceTexture.bind(decodedImageFor(inputs.cameraVideo));
    const faceCam = inputs.faceCam;

    const layout = cameraSize
      ? resolveFaceCamLayout(cameraSize.width, cameraSize.height, w, h, {
          shadowIntensity: faceCam?.shadowIntensity ?? 100,
          forceCircle: faceCam?.isRound === true,
          cornerRoundness: faceCam?.isRound ? undefined : faceCam?.roundness,
          widthPx: faceCam?.widthPx,
          heightPx: faceCam?.isRound ? faceCam?.widthPx : faceCam?.heightPx,
          corner: faceCam?.corner,
          crop: faceCam?.crop ?? null,
          positionOverride: faceCam?.position ?? null,
          presenceScale: inputs.faceCamPresenceScale,
          marginPx: faceCam?.marginPx,
        })
      : null;

    if (!layout) {
      faceRoot.visible = false;
      // Same as screen: `bind` can destroy the crop texture underneath us.
      faceSprite.texture = Texture.EMPTY;
      faceShadow.sprite.visible = false;
      return;
    }

    const {
      x,
      y,
      camWidth,
      camHeight,
      corner,
      presenceScale,
      cornerRadius,
      shadow,
    } = layout;
    faceRoot.visible = true;

    // Local space: the PiP lives at (0,0) inside faceRoot; presence scale
    // pivots from the tucked corner so it shrinks in place instead of
    // drifting.
    const anchorX =
      corner === "top-left" || corner === "bottom-left" ? 0 : camWidth;
    const anchorY =
      corner === "top-left" || corner === "top-right" ? 0 : camHeight;
    faceRoot.position.set(x + anchorX, y + anchorY);
    faceRoot.pivot.set(anchorX, anchorY);
    faceRoot.scale.set(presenceScale);

    faceShadow.update({
      key: `${shadow.w}x${shadow.h}|${shadow.r}|${faceCam?.shadowIntensity ?? 100}`,
      bake: (reuse) =>
        renderRoundedRectShadowSprite(
          reuse,
          shadow.w,
          shadow.h,
          shadow.r,
          faceCamShadowPasses(shadow),
        ),
      x: 0,
      y: 0,
    });

    scratchCrop.x = layout.sourceX;
    scratchCrop.y = layout.sourceY;
    scratchCrop.width = layout.sourceWidth;
    scratchCrop.height = layout.sourceHeight;
    faceSprite.texture = faceTexture.crop(scratchCrop);
    // setSize first, then flip: negative scale.x mirrors around the right edge.
    faceSprite.setSize(camWidth, camHeight);
    const mirrored = faceCam?.mirrored !== false;
    if (mirrored) {
      faceSprite.scale.x = -Math.abs(faceSprite.scale.x);
      faceSprite.position.set(camWidth, 0);
    } else {
      faceSprite.scale.x = Math.abs(faceSprite.scale.x);
      faceSprite.position.set(0, 0);
    }
    faceMask.set(0, 0, camWidth, camHeight, cornerRadius);
  }

  function dispose(): void {
    screenTexture.destroy();
    faceTexture.destroy();
    background.destroy();
    cursorOverlay.destroy();
    captionsLayer.destroy();
    recordingShadow.destroy();
    faceShadow.destroy();
    screenMask.destroy();
    faceMask.destroy();
    output.destroy();
    stage.destroy({ children: true });
    renderer.destroy();
  }

  console.info(
    `[compositor] pixi ready: gpu=${renderer.type === 2 ? "webgpu" : "webgl"} ` +
      `surface=${offscreen ? "offscreen" : "canvas"} antialias=${options.antialias !== false} ` +
      `mipmaps=${mipmaps} composition=${width}x${height} ` +
      `output=${outputWidth}x${outputHeight} downscale=${output.needsDownscale}`,
  );

  return {
    get canvas() {
      return readbackCanvas ?? pixiCanvas;
    },
    get readback() {
      return readbackCtx;
    },
    backend: "pixi",
    resize,
    compose,
    stats: () => profiler.report(),
    uploadStats: () => {
      const screen = screenTexture.stats();
      const face = faceTexture.stats();
      return {
        uploads: screen.uploads + face.uploads,
        skipped: screen.skipped + face.skipped,
      };
    },
    dispose,
  };
}

/**
 * Build the renderer, preferring an offscreen surface when the caller asked for
 * one. Export requires offscreen (`requireOffscreen`) so a failed OffscreenCanvas
 * GPU context cannot silently pace the loop to the display refresh.
 *
 * Backend order follows `gpuPreference` (preview tries WebGL first).
 */
async function createRenderer(
  options: FrameCompositorOptions,
  width: number,
  height: number,
): Promise<{ renderer: Renderer; offscreen: boolean }> {
  const preferences = options.gpuPreference?.length
    ? options.gpuPreference
    : (["webgpu", "webgl"] as const);

  const base = {
    width,
    height,
    // Multisampling antialiases rounded-corner stencil masks. Preview keeps it
    // on; export turns it off (fixed output, no interactive scrub).
    antialias: options.antialias !== false,
    background: 0x000000,
    backgroundAlpha: 1,
    resolution: 1,
    autoDensity: false,
    // Export hands the surface to the encoder (and to the GIF readback) after
    // `compose()` returns, so the drawing buffer has to survive the frame.
    preserveDrawingBuffer:
      options.preserveDrawingBuffer === true || options.cpuReadback === true,
    hello: false,
  };

  const tryPreferences = async (
    canvas?: HTMLCanvasElement,
  ): Promise<Renderer> => {
    const errors: string[] = [];
    for (const preference of preferences) {
      if (
        preference === "webgpu" &&
        !(typeof navigator !== "undefined" && "gpu" in navigator)
      ) {
        errors.push("webgpu: navigator.gpu unavailable");
        continue;
      }
      try {
        return (await autoDetectRenderer({
          ...base,
          preference,
          ...(canvas ? { canvas } : {}),
        })) as Renderer;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        errors.push(`${preference}: ${detail}`);
        console.warn(
          `[compositor] ${preference} init failed; trying next backend`,
          e,
        );
      }
    }
    throw new Error(
      `no GPU renderer available (${errors.join(" | ") || "no preferences"})`,
    );
  };

  if (options.offscreen && typeof OffscreenCanvas !== "undefined") {
    try {
      const renderer = await tryPreferences(
        new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
      );
      return { renderer, offscreen: true };
    } catch (e) {
      if (options.requireOffscreen) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(
          "export requires an OffscreenCanvas GPU surface (presentation-path " +
            `fallback would pace encode to the display refresh): ${detail}`,
        );
      }
      console.warn(
        "[compositor] offscreen surface unavailable; rendering through the " +
          "presentation path (may be paced by the display refresh)",
        e,
      );
    }
  } else if (options.requireOffscreen) {
    throw new Error(
      "export requires OffscreenCanvas, which is unavailable in this environment",
    );
  }

  return {
    renderer: await tryPreferences(),
    offscreen: false,
  };
}

// --- content keys ---------------------------------------------------------

/**
 * Stable ids for store-owned objects whose *identity* is what changes (the
 * background image, the cursor settings snapshot). Cheaper and more reliable
 * than hashing their contents once per frame.
 */
function identityKeyer(): (value: object) => number {
  const ids = new WeakMap<object, number>();
  let next = 1;
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = next++;
      ids.set(value, id);
    }
    return id;
  };
}

const imageIdOf = identityKeyer();

function imageId(image: CanvasImageSource): number {
  return imageIdOf(image as unknown as object);
}
