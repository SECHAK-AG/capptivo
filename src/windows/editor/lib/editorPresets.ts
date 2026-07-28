/**
 * Named editor look presets — snapshot + localStorage persistence.
 * Timeline (trims/zooms/cues) stays per-project and is never snapshotted.
 */

import {
  DEFAULT_CURSOR_SETTINGS,
  parseCursorSettings,
  type CursorSettings,
  type ScreenContentCropNorm,
} from "@/engine";
import {
  DEFAULT_CAPTION_SETTINGS,
  parseCaptionSettings,
  type CaptionSettings,
} from "@/captions/types";
import {
  DEFAULT_ASPECT_RATIO_PRESET_ID,
  DEFAULT_LOOK,
  isAspectRatioPresetId,
  type AspectRatioPresetId,
} from "./composition";
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
} from "../export/exportSettings";
import type { FaceCamParams, LookParams, PersistedBackground } from "../store";

export const EDITOR_PRESETS_STORAGE_KEY = "capptivo.editor.presets";
export const LAST_EXPORT_SETTINGS_KEY = "capptivo.editor.lastExportSettings";

const FALLBACK_FACE_CAM: FaceCamParams = {
  isRound: false,
  widthPx: 400,
  heightPx: 300,
  shadowIntensity: 100,
  roundness: 18,
  corner: "bottom-right",
  position: null,
  crop: null,
  mirrored: true,
  marginPx: 54,
};
export interface EditorPresetSnapshot {
  look: LookParams;
  background: PersistedBackground;
  faceCam: FaceCamParams;
  cursorSettings: CursorSettings;
  captionSettings: CaptionSettings;
  screenContentCrop: ScreenContentCropNorm | null;
  aspectRatioPresetId: AspectRatioPresetId;
  exportSettings: ExportSettings;
}

export interface EditorPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  snapshot: EditorPresetSnapshot;
}

const BACKGROUND_SELECTIONS: readonly PersistedBackground["selection"][] = [
  "none",
  "preset",
  "custom-color",
  "custom-gradient",
];

function clampLookNumber(
  n: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeLook(raw: unknown): LookParams {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LOOK };
  const d = raw as Record<string, unknown>;
  return {
    devicePadding: clampLookNumber(
      d.devicePadding,
      DEFAULT_LOOK.devicePadding,
      0,
      600,
    ),
    cornerRadius: clampLookNumber(
      d.cornerRadius,
      DEFAULT_LOOK.cornerRadius,
      0,
      300,
    ),
    recordingShadowIntensity: clampLookNumber(
      d.recordingShadowIntensity,
      DEFAULT_LOOK.recordingShadowIntensity,
      0,
      200,
    ),
    backgroundBlur: clampLookNumber(
      d.backgroundBlur,
      DEFAULT_LOOK.backgroundBlur,
      0,
      60,
    ),
    backgroundDarkness: clampLookNumber(
      d.backgroundDarkness,
      DEFAULT_LOOK.backgroundDarkness,
      0,
      100,
    ),
  };
}

function normalizeBackground(raw: unknown): PersistedBackground {
  if (!raw || typeof raw !== "object") {
    return {
      type: "image",
      selection: "none",
      presetId: null,
      customColor: "#22C55E",
      customGradientStart: "#8BC6EC",
      customGradientEnd: "#9599E2",
      customGradientAngle: 135,
    };
  }
  const d = raw as Record<string, unknown>;
  const type =
    d.type === "image" || d.type === "gradient" || d.type === "color"
      ? d.type
      : "image";
  return {
    type,
    selection: BACKGROUND_SELECTIONS.includes(
      d.selection as PersistedBackground["selection"],
    )
      ? (d.selection as PersistedBackground["selection"])
      : "none",
    presetId: typeof d.presetId === "string" ? d.presetId : null,
    customColor: typeof d.customColor === "string" ? d.customColor : "#22C55E",
    customGradientStart:
      typeof d.customGradientStart === "string"
        ? d.customGradientStart
        : "#8BC6EC",
    customGradientEnd:
      typeof d.customGradientEnd === "string" ? d.customGradientEnd : "#9599E2",
    customGradientAngle:
      typeof d.customGradientAngle === "number" &&
      Number.isFinite(d.customGradientAngle)
        ? Math.max(0, Math.min(360, Math.round(d.customGradientAngle)))
        : 135,
  };
}

function normalizeCrop(raw: unknown): ScreenContentCropNorm | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.x !== "number" ||
    typeof c.y !== "number" ||
    typeof c.width !== "number" ||
    typeof c.height !== "number"
  ) {
    return null;
  }
  return { x: c.x, y: c.y, width: c.width, height: c.height };
}

function normalizeExportSettings(raw: unknown): ExportSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_EXPORT_SETTINGS };
  const d = raw as Record<string, unknown>;
  const format =
    d.format === "gif" || d.format === "mp4"
      ? d.format
      : DEFAULT_EXPORT_SETTINGS.format;
  const container =
    d.container === "webm" || d.container === "mp4"
      ? d.container
      : DEFAULT_EXPORT_SETTINGS.container;
  const encoding =
    d.encoding === "fast" ||
    d.encoding === "balanced" ||
    d.encoding === "quality"
      ? d.encoding
      : DEFAULT_EXPORT_SETTINGS.encoding;
  const fps =
    d.fps === 24 || d.fps === 30 || d.fps === 60
      ? d.fps
      : DEFAULT_EXPORT_SETTINGS.fps;
  const audioEnhance =
    d.audioEnhance === "podcast" || d.audioEnhance === "off"
      ? d.audioEnhance
      : DEFAULT_EXPORT_SETTINGS.audioEnhance;
  return { format, container, encoding, fps, audioEnhance };
}

function normalizeFaceCam(raw: unknown): FaceCamParams {
  if (!raw || typeof raw !== "object") return { ...FALLBACK_FACE_CAM };
  const d = raw as Partial<FaceCamParams>;
  return {
    ...FALLBACK_FACE_CAM,
    ...d,
    crop:
      d.crop === undefined
        ? FALLBACK_FACE_CAM.crop
        : (d.crop as FaceCamParams["crop"]),
    position:
      d.position === undefined
        ? FALLBACK_FACE_CAM.position
        : (d.position as FaceCamParams["position"]),
    mirrored:
      typeof d.mirrored === "boolean" ? d.mirrored : FALLBACK_FACE_CAM.mirrored,
    marginPx:
      typeof d.marginPx === "number" && Number.isFinite(d.marginPx)
        ? Math.max(0, Math.min(96, d.marginPx))
        : FALLBACK_FACE_CAM.marginPx,
  };
}

export function normalizeEditorPresetSnapshot(
  raw: unknown,
): EditorPresetSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  return {
    look: normalizeLook(d.look),
    background: normalizeBackground(d.background),
    faceCam: normalizeFaceCam(d.faceCam),
    cursorSettings: parseCursorSettings(
      d.cursorSettings ?? DEFAULT_CURSOR_SETTINGS,
    ),
    captionSettings: parseCaptionSettings({
      ...DEFAULT_CAPTION_SETTINGS,
      ...(d.captionSettings && typeof d.captionSettings === "object"
        ? (d.captionSettings as object)
        : {}),
    }),
    screenContentCrop: normalizeCrop(d.screenContentCrop),
    aspectRatioPresetId: isAspectRatioPresetId(d.aspectRatioPresetId)
      ? d.aspectRatioPresetId
      : DEFAULT_ASPECT_RATIO_PRESET_ID,
    exportSettings: normalizeExportSettings(d.exportSettings),
  };
}

export function normalizeEditorPresets(raw: unknown): EditorPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: EditorPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name.trim() : "";
    if (!name) continue;
    const snapshot = normalizeEditorPresetSnapshot(d.snapshot);
    if (!snapshot) continue;
    const id =
      typeof d.id === "string" && d.id.length > 0
        ? d.id
        : typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `preset-${Date.now()}-${out.length}`;
    const createdAt =
      typeof d.createdAt === "string" && d.createdAt.length > 0
        ? d.createdAt
        : new Date().toISOString();
    const updatedAt =
      typeof d.updatedAt === "string" && d.updatedAt.length > 0
        ? d.updatedAt
        : createdAt;
    out.push({ id, name, createdAt, updatedAt, snapshot });
  }
  return out;
}

function readLocalStorageJson(key: string): unknown | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeLocalStorageJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadEditorPresets(): EditorPreset[] {
  return normalizeEditorPresets(
    readLocalStorageJson(EDITOR_PRESETS_STORAGE_KEY),
  );
}

export function saveEditorPresets(presets: EditorPreset[]): boolean {
  return writeLocalStorageJson(
    EDITOR_PRESETS_STORAGE_KEY,
    normalizeEditorPresets(presets),
  );
}

/** Stable signature so the active preset clears when the user drifts from it. */
export function serializeEditorPresetSnapshot(
  snapshot: EditorPresetSnapshot,
): string {
  return JSON.stringify(snapshot);
}

/** Look-only signature (export knobs don't affect the on-canvas match highlight). */
export function serializeEditorPresetLook(
  snapshot: EditorPresetSnapshot,
): string {
  const { exportSettings: _exportSettings, ...look } = snapshot;
  return JSON.stringify(look);
}

export function loadLastExportSettings(): ExportSettings {
  return normalizeExportSettings(
    readLocalStorageJson(LAST_EXPORT_SETTINGS_KEY),
  );
}

export function saveLastExportSettings(settings: ExportSettings): boolean {
  return writeLocalStorageJson(
    LAST_EXPORT_SETTINGS_KEY,
    normalizeExportSettings(settings),
  );
}

export function newPresetId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `preset-${Date.now()}`;
}
