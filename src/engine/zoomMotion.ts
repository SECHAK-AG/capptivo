import {
  createSmartFollowPlanner,
  createSmartFollowRuntime,
  sampleMappedPointsAtTime,
  stepSmartFollowCursor,
} from "./smartFollowCursor.ts";

/**
 * OS cursor shape ids — must match recorder serde and `public/cursors/` glyph files.
 */
export const CURSOR_SHAPE_IDS = [
  "default",
  "pointer",
  "text",
  "grab",
  "grabbing",
  "crosshair",
  "resize-ew",
  "resize-ns",
  "resize-nesw",
  "resize-nwse",
  "not-allowed",
  "alias",
  "copy",
  "context-menu",
] as const;
export type CursorShapeId = (typeof CURSOR_SHAPE_IDS)[number];

export type CursorSample = {
  t: number;
  x: number;
  y: number;
  /** Omitted in old recordings and when the shape is the plain arrow. */
  shape?: CursorShapeId;
};

export type CursorClickSample = {
  t: number;
  x: number;
  y: number;
};

/** One button hold: mouse-down at `start`, mouse-up at `end` (source time). */
export type CursorPressInterval = { start: number; end: number };

export type RecordingMetadata = {
  schemaVersion: 1 | 2;
  sourceWidth: number;
  sourceHeight: number;
  cursorSamples: CursorSample[];
  cursorClickSamples?: CursorClickSample[];
  /** Down→up hold windows, for the click press effect. Absent in old tracks. */
  cursorPressIntervals?: CursorPressInterval[];
  hasCamera?: boolean;
  captureSurface?: "monitor" | "window" | "browser";
  captureOs?: "windows" | "macos" | "linux" | "unknown";
  /** Pixels cropped from bottom at record time (e.g. Windows taskbar). */
  screenBottomCropPx?: number;
  /** Wall-clock recording length in seconds (client side). */
  durationSeconds?: number;
};

/**
 * Fixed zoom frame in **composition / stage NDC** (0–1 of the full canvas,
 * including background padding). Camera focus is derived by mapping the rect
 * centre through the laid-out recording rect (see `stageNdcToRecordingNdc`).
 */
export type FixedZoomRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ZoomMode = "follow-cursor" | "fixed-rect";
export type FixedZoomMode = "target" | "frame";

export type ZoomFragment = {
  id: string;
  start: number;
  end: number;
  mode: ZoomMode;
  /** @deprecated Ignored; zoom always uses the camera (full stage). Kept for old editor_state. */
  scope?: "video" | "scene";
  fixedMode?: FixedZoomMode;
  /** @deprecated Ignored; padding shrink was recording-only zoom. Kept for old editor_state. */
  reduceBackgroundPadding?: boolean;
  /** @deprecated Ignored; padding shrink was recording-only zoom. Kept for old editor_state. */
  paddingReductionAmount?: number;
  targetScale: number;
  easeIn: number;
  easeOut: number;
  /** Follow-cursor pan inertia (1–20); higher = slower. Ignored for fixed-rect. */
  damping: number;
  fixedRect?: FixedZoomRect;
  /** When true (default), face cam eases smaller during this fragment. */
  shrinkFaceCamDuringZoom?: boolean;
  /** Face-cam scale at full zoom (0.35–1). */
  faceCamZoomPresenceScale?: number;
};

export function getShrinkFaceCamDuringZoom(
  fragment: ZoomFragment | null | undefined,
): boolean {
  if (!fragment) {
    return true;
  }

  return fragment.shrinkFaceCamDuringZoom !== false;
}

export const DEFAULT_FACE_CAM_ZOOM_PRESENCE_SCALE = 0.62;
export const MIN_FACE_CAM_ZOOM_PRESENCE_SCALE = 0.35;
export const MAX_FACE_CAM_ZOOM_PRESENCE_SCALE = 1;

export function getFaceCamZoomPresenceMinScale(
  fragment: ZoomFragment | null | undefined,
): number {
  const raw = fragment?.faceCamZoomPresenceScale;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clamp(
      raw,
      MIN_FACE_CAM_ZOOM_PRESENCE_SCALE,
      MAX_FACE_CAM_ZOOM_PRESENCE_SCALE,
    );
  }

  return DEFAULT_FACE_CAM_ZOOM_PRESENCE_SCALE;
}

export type ZoomMotionState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

/** Pre-computed zoom target for a specific time - used for export */
export type ZoomKeyframe = {
  t: number;
  x: number;
  y: number;
  scale: number;
};

/**
 * When the editor uses a sub-rect of the screen recording (e.g. crop browser
 * chrome), map full-source NDC (0–1 of the file) to NDC inside that rect.
 * When omitted, pan/zoom uses the same coordinate system as before.
 */
export type ZoomContentSpaceMap = (fullNorm: { x: number; y: number }) => {
  x: number;
  y: number;
};

/** Global screen crop: normalized 0–1 in full file pixel space (not a zoom / motion). */
export type ScreenContentCropNorm = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_CONTENT_CROP = 0.02;

export function clampScreenContentCropNorm(
  c: ScreenContentCropNorm,
): ScreenContentCropNorm {
  const x = Math.min(1, Math.max(0, c.x));
  const y = Math.min(1, Math.max(0, c.y));
  const maxW = Math.max(MIN_CONTENT_CROP, 1 - x);
  const maxH = Math.max(MIN_CONTENT_CROP, 1 - y);
  const width = Math.max(
    MIN_CONTENT_CROP,
    Math.min(maxW, Math.min(1, c.width)),
  );
  const height = Math.max(
    MIN_CONTENT_CROP,
    Math.min(maxH, Math.min(1, c.height)),
  );
  return { x, y, width, height };
}

/**
 * Map full-file NDC into user crop space (zoom/cursor run inside the cropped window).
 */
export function createFullNormToContentNdcFromCrop(
  crop: ScreenContentCropNorm,
): ZoomContentSpaceMap {
  const w = Math.max(1e-9, crop.width);
  const h = Math.max(1e-9, crop.height);
  return (p) => ({
    x: clamp((p.x - crop.x) / w, 0, 1),
    y: clamp((p.y - crop.y) / h, 0, 1),
  });
}

/** Aspect of visible screen pixels after optional content crop. */
export function computeEffectiveSourceAspect(params: {
  videoWidth: number;
  videoHeight: number;
  screenContentCrop?: ScreenContentCropNorm | null;
}): number {
  const videoWidth = Math.max(1, params.videoWidth);
  const videoHeight = Math.max(1, params.videoHeight);
  const baseAspect = videoWidth / videoHeight;
  const crop = params.screenContentCrop;
  if (crop && crop.width > 1e-6 && crop.height > 1e-6) {
    return (crop.width / crop.height) * baseAspect;
  }
  return baseAspect;
}

export function contentRectPixelsFromCrop(
  videoWidth: number,
  videoHeight: number,
  crop: ScreenContentCropNorm,
): { ox: number; oy: number; rw: number; rh: number } {
  const c = clampScreenContentCropNorm(crop);
  const w = Math.max(1, videoWidth);
  const h = Math.max(1, videoHeight);
  return {
    ox: c.x * w,
    oy: c.y * h,
    rw: c.width * w,
    rh: c.height * h,
  };
}

/** Offline zoom keyframe sample rate (preview + export). */
export const ZOOM_MOTION_SAMPLE_FPS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scaleFromFixedRect(rect: FixedZoomRect): number {
  const maxSide = Math.max(1e-6, Math.max(rect.width, rect.height));
  return clamp(1 / maxSide, 1, 3);
}

export function createZoomFragmentId(): string {
  return `zoom-${Math.random().toString(36).slice(2, 10)}`;
}

export function findActiveZoomFragment(
  fragments: ZoomFragment[],
  time: number,
): ZoomFragment | null {
  return fragments.find((f) => time >= f.start && time <= f.end) ?? null;
}

/** Active zoom for face-cam shrink; prefers the inspector-selected fragment when the playhead is on it. */
export function zoomFragmentForFaceCamPresence(
  fragments: ZoomFragment[],
  time: number,
  preferredFragmentId?: string | null,
): ZoomFragment | null {
  const preferred = preferredFragmentId
    ? (fragments.find((f) => f.id === preferredFragmentId) ?? null)
    : null;

  if (
    preferred &&
    time >= preferred.start &&
    time <= preferred.end &&
    getShrinkFaceCamDuringZoom(preferred)
  ) {
    return preferred;
  }

  return findActiveZoomFragment(fragments, time);
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  if (x < 0.5) return 4 * x * x * x;
  return 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

export function computeZoomEnvelope(
  fragment: ZoomFragment,
  time: number,
): number {
  const total = Math.max(1e-6, fragment.end - fragment.start);
  const local = clamp(time - fragment.start, 0, total);
  const safeEaseIn = clamp(fragment.easeIn, 0, total / 2);
  const safeEaseOut = clamp(fragment.easeOut, 0, total / 2);

  if (safeEaseIn > 0 && local < safeEaseIn) {
    return easeOutCubic(local / safeEaseIn);
  }

  if (safeEaseOut > 0 && local > total - safeEaseOut) {
    const progress = clamp((local - (total - safeEaseOut)) / safeEaseOut, 0, 1);
    return 1 - easeOutCubic(progress);
  }

  return 1;
}

export function sampleCursorAtTime(
  metadata: RecordingMetadata | null,
  time: number,
): { x: number; y: number } | null {
  if (!metadata || metadata.cursorSamples.length === 0) return null;

  const samples = metadata.cursorSamples;
  if (time <= samples[0].t) {
    return { x: samples[0].x, y: samples[0].y };
  }

  const last = samples[samples.length - 1];
  if (time >= last.t) {
    return { x: last.x, y: last.y };
  }

  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  const a = samples[lo];
  const b = samples[Math.min(lo + 1, samples.length - 1)];
  const span = Math.max(1e-6, b.t - a.t);
  const p = Math.min(1, Math.max(0, (time - a.t) / span));
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
  };
}

export function sampleCursorClickPulseAtTime(
  metadata: RecordingMetadata | null,
  time: number,
): { x: number; y: number; progress: number } | null {
  if (
    !metadata?.cursorClickSamples ||
    metadata.cursorClickSamples.length === 0
  ) {
    return null;
  }

  const pulseDuration = 0.34;
  const samples = metadata.cursorClickSamples;

  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const click = samples[i];
    const elapsed = time - click.t;

    if (elapsed < 0) {
      continue;
    }

    if (elapsed > pulseDuration) {
      break;
    }

    return {
      x: click.x,
      y: click.y,
      progress: elapsed / pulseDuration,
    };
  }

  return null;
}

/** Cursor follow tuned for demo-style zoom motion. */
export const ZOOM_FOLLOW = {
  STIFFNESS: 9.2,
  DAMPING: 0.9,
  MAX_VELOCITY: 3.4,
  /** Base follow τ at damping=4; actual τ = this × (damping / 4). */
  FOLLOW_CENTER_TAU_SEC: 0.55,
  /** Overdamped spring ζ for follow-cursor pan. */
  FOLLOW_SPRING_ZETA: 1.05,
} as const;

export function sampleCursorFromHistory(
  history: { t: number; x: number; y: number }[],
  time: number,
): { x: number; y: number } | null {
  if (history.length === 0) return null;
  const first = history[0];
  const last = history[history.length - 1];
  if (time <= first.t) return { x: first.x, y: first.y };
  if (time >= last.t) return { x: last.x, y: last.y };
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i];
    const b = history[i + 1];
    if (time >= a.t && time <= b.t) {
      const span = Math.max(1e-9, b.t - a.t);
      const p = (time - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * p,
        y: a.y + (b.y - a.y) * p,
      };
    }
  }
  return null;
}

export function getZoomTarget(
  fragment: ZoomFragment,
  time: number,
  metadata: RecordingMetadata | null,
): { x: number; y: number } {
  if (fragment.mode === "fixed-rect" && fragment.fixedRect) {
    // Stage-NDC centre; callers that need recording-NDC must map via layout.
    return {
      x: fragment.fixedRect.x + fragment.fixedRect.width / 2,
      y: fragment.fixedRect.y + fragment.fixedRect.height / 2,
    };
  }

  const cursor = sampleCursorAtTime(metadata, time);
  return cursor ?? { x: 0.5, y: 0.5 };
}

/**
 * Keep zoom center inside visible crop for `scale`; at 1× forces frame midpoint.
 */
export function clampTargetForScale(
  target: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const safeScale = Math.max(1, scale);
  const halfVisible = 0.5 / safeScale;
  const minCenter = halfVisible;
  const maxCenter = 1 - halfVisible;
  if (minCenter >= maxCenter - 1e-9) {
    return { x: 0.5, y: 0.5 };
  }

  return {
    x: clamp(target.x, minCenter, maxCenter),
    y: clamp(target.y, minCenter, maxCenter),
  };
}

/**
 * Full-zoom scale (S) for a zoom fragment. Fixed-rect derives S from
 * the chosen rectangle; other modes use authored `targetScale`.
 */
export function getSceneZoomTargetScale(fragment: ZoomFragment): number {
  if (fragment.mode === "fixed-rect" && fragment.fixedRect) {
    return scaleFromFixedRect(fragment.fixedRect);
  }
  return Math.max(1, fragment.targetScale ?? 1);
}

/** Render scale: hyperbolic ramp for fixed-rect, linear for follow-cursor. */
export function computeSceneZoomScale(
  activeZoom: ZoomFragment | null | undefined,
  envelope: number,
): number {
  if (!activeZoom) {
    return 1;
  }

  const env = Number.isFinite(envelope) ? clamp(envelope, 0, 1) : 0;
  const S = Math.max(1, getSceneZoomTargetScale(activeZoom));

  if (S - 1 < 1e-6 || env <= 0) {
    return 1;
  }

  if (activeZoom.mode === "fixed-rect") {
    return S / Math.max(1e-6, S - (S - 1) * env);
  }

  return 1 + (S - 1) * env;
}

/** Zoom pivot in recording NDC — keyframe / follow pan (fixed-rect is baked already mapped). */
export function computeSceneZoomPivotNdc(
  _activeZoom: ZoomFragment | null | undefined,
  pan: { x: number; y: number },
): { x: number; y: number } {
  return { x: pan.x, y: pan.y };
}

/** Focal for zoom: fixed-rect lerps centre→rect; follow-cursor uses keyframe pan. */
export function computeSceneZoomRenderCenter(
  activeZoom: ZoomFragment | null | undefined,
  pan: { x: number; y: number },
  zoomScale: number,
  zoomEnvelope: number,
): { x: number; y: number } {
  const raw = computeSceneZoomPivotNdc(activeZoom, pan);

  if (!activeZoom) {
    return raw;
  }

  const s = Math.max(1, zoomScale);
  const env = Number.isFinite(zoomEnvelope) ? clamp(zoomEnvelope, 0, 1) : 0;

  if (env <= 1e-9 || s <= 1 + 1e-6) {
    return { x: 0.5, y: 0.5 };
  }

  if (activeZoom.mode === "fixed-rect") {
    // Allow focus onto composition padding (outside recording 0–1).
    return {
      x: 0.5 + (raw.x - 0.5) * env,
      y: 0.5 + (raw.y - 0.5) * env,
    };
  }

  return clampTargetForScale(raw, s);
}

/** Apply scale/focal overrides on baked keyframe pan/scale. */
export function resolveSceneZoomView(
  activeZoom: ZoomFragment | null | undefined,
  sourceTime: number,
  pan: { x: number; y: number },
  keyframeScale: number,
): { scale: number; center: { x: number; y: number } } {
  if (!activeZoom) {
    return { scale: keyframeScale, center: { x: pan.x, y: pan.y } };
  }

  const envelope = computeZoomEnvelope(activeZoom, sourceTime);
  const scale = computeSceneZoomScale(activeZoom, envelope);
  const center = computeSceneZoomRenderCenter(activeZoom, pan, scale, envelope);
  return { scale, center };
}

export function stepSpringMotion(
  state: ZoomMotionState,
  target: { x: number; y: number },
  dtSeconds: number,
  stiffness: number = ZOOM_FOLLOW.STIFFNESS,
  dampingRatio: number = ZOOM_FOLLOW.DAMPING,
  maxVelocity: number = ZOOM_FOLLOW.MAX_VELOCITY,
): ZoomMotionState {
  const safeDt = Math.max(1e-6, Math.min(dtSeconds, 0.05));

  const omega = stiffness;
  const zeta = dampingRatio;

  const dx = target.x - state.x;
  const dy = target.y - state.y;

  const ax = omega * omega * dx - 2 * zeta * omega * state.vx;
  const ay = omega * omega * dy - 2 * zeta * omega * state.vy;

  const newVx = clamp(state.vx + ax * safeDt, -maxVelocity, maxVelocity);
  const newVy = clamp(state.vy + ay * safeDt, -maxVelocity, maxVelocity);
  const newX = state.x + newVx * safeDt;
  const newY = state.y + newVy * safeDt;

  return {
    x: clamp(newX, 0, 1),
    y: clamp(newY, 0, 1),
    vx: newVx,
    vy: newVy,
  };
}

/** Simple exponential smoothing */
export function stepSmoothMotion(
  current: { x: number; y: number },
  target: { x: number; y: number },
  dtSeconds: number,
  speed: number = 5.0,
): { x: number; y: number } {
  const safeDt = Math.max(0, dtSeconds);
  const alpha = 1 - Math.exp(-speed * safeDt);
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
  };
}

/** Time constant (seconds) for follow-cursor pan easing from `fragment.damping`. */
function followCenterTauSeconds(fragment: ZoomFragment): number {
  const raw = fragment.damping;
  let d = typeof raw === "number" && Number.isFinite(raw) ? raw : 4;
  if (d < 1) {
    d = 4;
  }
  d = clamp(d, 1, 20);
  return ZOOM_FOLLOW.FOLLOW_CENTER_TAU_SEC * (d / 4);
}

/** Spring stiffness (ω) from fragment damping — same τ scale as before, stiffer ≈ snappier. */
function followSpringStiffnessFromFragment(fragment: ZoomFragment): number {
  const tau = followCenterTauSeconds(fragment);
  return clamp(2.95 / Math.max(tau, 0.065), 4.2, 30);
}

/** Integrate one zoom fragment — identical stepping to export sampling. */
export function computeZoomKeyframes(
  fragment: ZoomFragment,
  metadata: RecordingMetadata | null,
  fps: number = ZOOM_MOTION_SAMPLE_FPS,
  fullNormToContentNdc?: ZoomContentSpaceMap,
  /**
   * Maps fixed-rect stage-NDC centres → recording NDC. When omitted, the rect
   * is treated as already in recording space (tests / no-layout callers).
   */
  stageCenterToRecordingNdc?: ZoomContentSpaceMap,
): ZoomKeyframe[] {
  const toContent = (p: { x: number; y: number }): { x: number; y: number } => {
    return fullNormToContentNdc ? fullNormToContentNdc(p) : p;
  };

  const keyframes: ZoomKeyframe[] = [];
  const duration = fragment.end - fragment.start;
  const frameCount = Math.ceil(duration * fps);

  let motionState: ZoomMotionState = { x: 0.5, y: 0.5, vx: 0, vy: 0 };

  const dt = 1 / Math.max(1, fps);
  const smartFollowPlanner =
    fragment.mode === "follow-cursor"
      ? createSmartFollowPlanner(metadata, fragment, toContent)
      : null;
  let smartFollowRuntime =
    smartFollowPlanner !== null
      ? createSmartFollowRuntime({
          x: motionState.x,
          y: motionState.y,
        })
      : null;
  const followSpringStiffness = followSpringStiffnessFromFragment(fragment);
  let easeOutAnchor: { x: number; y: number } | null = null;

  const easeInSeed =
    fragment.mode === "follow-cursor" && smartFollowPlanner
      ? sampleMappedPointsAtTime(smartFollowPlanner.samples, fragment.start)
      : null;

  const totalDuration = Math.max(1e-6, fragment.end - fragment.start);
  const safeEaseOut = clamp(fragment.easeOut, 0, totalDuration / 2);
  const easeOutStartT =
    safeEaseOut > 0 ? fragment.end - safeEaseOut : fragment.end;

  /** Lerp pan anchor → centre on the same envelope timeline as scale. */
  const easeOutPan = (
    anchor: { x: number; y: number },
    envelope: number,
    zoomScale: number,
    softClamp: boolean,
  ): { x: number; y: number } => {
    const interp = {
      x: 0.5 + (anchor.x - 0.5) * envelope,
      y: 0.5 + (anchor.y - 0.5) * envelope,
    };
    return softClamp ? clampTargetForScale(interp, zoomScale) : interp;
  };

  for (let i = 0; i <= frameCount; i += 1) {
    const t = fragment.start + i / fps;
    const envelope = computeZoomEnvelope(fragment, t);
    // Fixed-rect: hyperbolic scale so the visible window shrinks evenly onto
    // the rect. Follow-cursor: linear scale; ease-in pan lerps centre→seed.
    const zoomScale =
      fragment.mode === "fixed-rect"
        ? computeSceneZoomScale(fragment, envelope)
        : 1 + (Math.max(1, fragment.targetScale) - 1) * envelope;

    const inEaseOut = safeEaseOut > 0 && t > easeOutStartT && envelope < 1;

    const cursor =
      fragment.mode === "follow-cursor" && smartFollowPlanner
        ? sampleMappedPointsAtTime(smartFollowPlanner.samples, t)
        : null;

    if (fragment.mode === "follow-cursor" && cursor && smartFollowPlanner) {
      const cx = cursor.x;
      const cy = cursor.y;

      if (inEaseOut) {
        if (!easeOutAnchor) {
          easeOutAnchor = { x: motionState.x, y: motionState.y };
        }
        const panned = easeOutPan(easeOutAnchor, envelope, zoomScale, true);
        motionState = { x: panned.x, y: panned.y, vx: 0, vy: 0 };
        smartFollowRuntime = createSmartFollowRuntime({
          x: motionState.x,
          y: motionState.y,
        });
      } else if (envelope < 1) {
        // Fixed-focus zoom-in: focus stays on the start seed (clamped at full S).
        // Only scale eases — the camera applies progress·finalOffset so there is
        // no centre→seed pan slide. Smart-follow starts on plateau.
        const seed = easeInSeed ?? { x: cx, y: cy };
        const fullScale = Math.max(1, fragment.targetScale);
        const focus = clampTargetForScale(seed, fullScale);
        motionState = { x: focus.x, y: focus.y, vx: 0, vy: 0 };
        smartFollowRuntime = createSmartFollowRuntime({
          x: motionState.x,
          y: motionState.y,
        });
      } else if (smartFollowRuntime) {
        const stepped = stepSmartFollowCursor({
          planner: smartFollowPlanner,
          runtime: smartFollowRuntime,
          motionState,
          cursor: { x: cx, y: cy },
          time: t,
          scale: zoomScale,
          dt,
          fragment,
          phase: "plateau",
          followSpringStiffness,
          springZeta: ZOOM_FOLLOW.FOLLOW_SPRING_ZETA,
          maxVelocity: ZOOM_FOLLOW.MAX_VELOCITY,
        });
        motionState = stepped.motionState;
        smartFollowRuntime = stepped.runtime;
      }
    } else if (fragment.mode === "fixed-rect" && fragment.fixedRect) {
      const stageCenter = {
        x: fragment.fixedRect.x + fragment.fixedRect.width / 2,
        y: fragment.fixedRect.y + fragment.fixedRect.height / 2,
      };
      const mapped = stageCenterToRecordingNdc
        ? stageCenterToRecordingNdc(stageCenter)
        : stageCenter;
      const fixedCenter = toContent(mapped);
      // Lerp centre → rect with the envelope (ease-in, plateau, ease-out).
      // Snapping pan to the rect while scale is still ~1× reads as a hard crop.
      // Padding focus is intentional — do not clamp into the recording texture.
      const panned = computeSceneZoomRenderCenter(
        fragment,
        fixedCenter,
        zoomScale,
        envelope,
      );
      motionState = { x: panned.x, y: panned.y, vx: 0, vy: 0 };
    }

    const safe =
      fragment.mode === "fixed-rect"
        ? { x: motionState.x, y: motionState.y }
        : clampTargetForScale(
            { x: motionState.x, y: motionState.y },
            // Ease-in holds focus at full-S clamp; re-clamping to the growing
            // scale would ride the clamp edge (the old L/R hunt).
            envelope < 1 && !inEaseOut
              ? Math.max(1, fragment.targetScale)
              : zoomScale,
          );
    motionState = { ...motionState, x: safe.x, y: safe.y };
    keyframes.push({ t, x: safe.x, y: safe.y, scale: zoomScale });
  }

  return keyframes;
}

export function interpolateZoomKeyframe(
  keyframes: ZoomKeyframe[],
  time: number,
): ZoomKeyframe {
  if (keyframes.length === 0) {
    return { t: time, x: 0.5, y: 0.5, scale: 1 };
  }
  if (time <= keyframes[0].t) {
    const k = keyframes[0];
    return { t: time, x: k.x, y: k.y, scale: k.scale };
  }
  const last = keyframes[keyframes.length - 1];
  if (time >= last.t) {
    return { t: time, x: last.x, y: last.y, scale: last.scale };
  }

  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].t <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a = keyframes[lo];
  const b = keyframes[hi];
  const u = (time - a.t) / Math.max(1e-9, b.t - a.t);
  return {
    t: time,
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    scale: a.scale + (b.scale - a.scale) * u,
  };
}

/** Same pan/zoom as export for the current playback time. */
export function resolveZoomPanAtTime(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  time: number,
  keyframesByFragmentId: Map<string, ZoomKeyframe[]>,
  fps: number = ZOOM_MOTION_SAMPLE_FPS,
  fullNormToContentNdc?: ZoomContentSpaceMap,
): { x: number; y: number; scale: number } {
  const active = findActiveZoomFragment(fragments, time);
  if (!active) {
    return { x: 0.5, y: 0.5, scale: 1 };
  }
  let kfs = keyframesByFragmentId.get(active.id);
  if (!kfs || kfs.length === 0) {
    kfs = computeZoomKeyframes(active, metadata, fps, fullNormToContentNdc);
    keyframesByFragmentId.set(active.id, kfs);
  }
  const k = interpolateZoomKeyframe(kfs, time);
  return { x: k.x, y: k.y, scale: k.scale };
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** @deprecated use SMART_FOLLOW_CONFIG from smartFollowCursor */
export const SMART_FOLLOW = {
  LOOKBACK_SECONDS: 0,
  DISPLACEMENT_THRESHOLD: 0,
  DEBOUNCE_FRAMES: 0,
  SPRING_STIFFNESS: ZOOM_FOLLOW.STIFFNESS,
  SPRING_DAMPING: ZOOM_FOLLOW.DAMPING,
  MAX_VELOCITY: ZOOM_FOLLOW.MAX_VELOCITY,
  DEADZONE: 0.008,
  PREDICTION_FACTOR: 0,
} as const;

export const FOLLOW_CURSOR_DISPLACEMENT_THRESHOLD =
  SMART_FOLLOW.DISPLACEMENT_THRESHOLD;
export const FOLLOW_CURSOR_LOOKBACK_SECONDS = SMART_FOLLOW.LOOKBACK_SECONDS;
export const FOLLOW_CURSOR_DEBOUNCE_FRAMES = SMART_FOLLOW.DEBOUNCE_FRAMES;
export const FOLLOW_MOTION_MAX_ALPHA = 0.3;

export function stepMotionState(
  previous: ZoomMotionState,
  target: { x: number; y: number },
  dtSeconds: number,
  damping: number,
  _maxAlpha: number = 0.3,
): ZoomMotionState {
  return stepSpringMotion(previous, target, dtSeconds, damping * 2, 0.8);
}

export function getFollowCursorTarget(
  cursorNow: { x: number; y: number },
  cursorPast: { x: number; y: number },
  _motionState?: ZoomMotionState,
  displacementThreshold: number = SMART_FOLLOW.DISPLACEMENT_THRESHOLD,
): { target: { x: number; y: number }; isAboveThreshold: boolean } {
  const d = distance(cursorNow, cursorPast);
  const isAboveThreshold = d > displacementThreshold;
  return {
    target: isAboveThreshold ? cursorNow : cursorPast,
    isAboveThreshold,
  };
}
