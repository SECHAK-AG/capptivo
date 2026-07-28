/** Web-editor–compatible caption style (Laravel `captionDrawer`). */

export type CaptionSettings = {
  enabled: boolean;
  /** Whisper language (desktop generate only). */
  language: string;
  sentenceBackground: string | null;
  wordBackground: string | null;
  wordTextColor: string | null;
  sentenceRadiusPx: number;
  wordRadiusPx: number;
  textColor: string;
  fontFamily: string;
  fontSizePx: number;
  bottomOffsetPx: number;
  /** Follow the spoken word with highlight (requires Whisper JSON word timings). */
  wordHighlight: boolean;
  /** Nudge karaoke vs playback (negative = highlight earlier). */
  timingOffsetMs: number;
};

const LEGACY_CAPTION_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Subtitle font presets (canvas + preview). Keep in sync with `editor.html` font link. */
export const CAPTION_FONT_OPTIONS = [
  { label: "System UI", value: "system-ui, -apple-system, sans-serif" },
  { label: "Poppins", value: '"Poppins", system-ui, sans-serif' },
  { label: "Inter", value: '"Inter", system-ui, sans-serif' },
  {
    label: "Monospace",
    value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
] as const;

const CAPTION_FONT_VALUES = new Set<string>(
  CAPTION_FONT_OPTIONS.map((o) => o.value),
);

function normalizeCaptionFontFamily(raw: string): string {
  if (CAPTION_FONT_VALUES.has(raw)) return raw;
  if (raw === LEGACY_CAPTION_FONT_FAMILY) {
    return DEFAULT_CAPTION_SETTINGS.fontFamily;
  }
  const lower = raw.toLowerCase();
  if (lower.includes("poppins")) return CAPTION_FONT_OPTIONS[1].value;
  if (lower.includes("inter")) return CAPTION_FONT_OPTIONS[2].value;
  if (lower.includes("mono") || lower.includes("menlo") || lower.includes("consolas")) {
    return CAPTION_FONT_OPTIONS[3].value;
  }
  return DEFAULT_CAPTION_SETTINGS.fontFamily;
}

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  enabled: false,
  language: "auto",
  sentenceBackground: "rgba(8, 8, 10, 0.82)",
  wordBackground: "rgba(255, 255, 255, 0.22)",
  wordTextColor: null,
  sentenceRadiusPx: 8,
  wordRadiusPx: 6,
  textColor: "#ffffff",
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSizePx: 38,
  bottomOffsetPx: 48,
  wordHighlight: true,
  timingOffsetMs: 0,
};

function clampPx(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** @deprecated use CaptionSettings */
export type AutoCaptionSettings = CaptionSettings;

/** @deprecated use DEFAULT_CAPTION_SETTINGS */
export const DEFAULT_AUTO_CAPTION_SETTINGS = DEFAULT_CAPTION_SETTINGS;

function clampMs(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function parseCaptionSettings(raw: unknown): CaptionSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CAPTION_SETTINGS };
  }
  const o = raw as Record<string, unknown>;

  const legacyFontSize =
    typeof o.fontSize === "number" && Number.isFinite(o.fontSize) ? o.fontSize : undefined;
  const legacyBottom =
    typeof o.bottomOffset === "number" && Number.isFinite(o.bottomOffset)
      ? o.bottomOffset
      : undefined;
  const legacyBoxRadius =
    typeof o.boxRadius === "number" && Number.isFinite(o.boxRadius) ? o.boxRadius : undefined;
  const legacyBgOpacity =
    typeof o.backgroundOpacity === "number" && Number.isFinite(o.backgroundOpacity)
      ? o.backgroundOpacity
      : undefined;

  let sentenceBackground: string | null;
  if (o.sentenceBackground === null) {
    sentenceBackground = null;
  } else if (typeof o.sentenceBackground === "string") {
    sentenceBackground = o.sentenceBackground;
  } else if (legacyBgOpacity !== undefined && o.sentenceBackground === undefined) {
    sentenceBackground = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, legacyBgOpacity))})`;
  } else {
    sentenceBackground = DEFAULT_CAPTION_SETTINGS.sentenceBackground;
  }

  const bottomOffsetPx =
    o.bottomOffsetPx !== undefined
      ? clampPx(o.bottomOffsetPx, 8, 200, DEFAULT_CAPTION_SETTINGS.bottomOffsetPx)
      : legacyBottom !== undefined && legacyBottom <= 30
        ? clampPx(legacyBottom * 16, 8, 200, DEFAULT_CAPTION_SETTINGS.bottomOffsetPx)
        : DEFAULT_CAPTION_SETTINGS.bottomOffsetPx;

  return {
    enabled: o.enabled === true,
    language:
      typeof o.language === "string" && o.language.trim()
        ? o.language.trim()
        : DEFAULT_CAPTION_SETTINGS.language,
    sentenceBackground,
    wordBackground:
      o.wordBackground === null
        ? null
        : typeof o.wordBackground === "string"
          ? o.wordBackground
          : DEFAULT_CAPTION_SETTINGS.wordBackground,
    wordTextColor:
      o.wordTextColor === null
        ? null
        : typeof o.wordTextColor === "string"
          ? o.wordTextColor
          : DEFAULT_CAPTION_SETTINGS.wordTextColor,
    sentenceRadiusPx: clampPx(
      o.sentenceRadiusPx ?? legacyBoxRadius,
      0,
      48,
      DEFAULT_CAPTION_SETTINGS.sentenceRadiusPx,
    ),
    wordRadiusPx: clampPx(o.wordRadiusPx, 0, 48, DEFAULT_CAPTION_SETTINGS.wordRadiusPx),
    textColor: captionColorPickerValue(
      typeof o.textColor === "string" ? o.textColor : null,
      DEFAULT_CAPTION_SETTINGS.textColor,
    ),
    fontFamily: normalizeCaptionFontFamily(
      typeof o.fontFamily === "string" ? o.fontFamily.trim() : "",
    ),
    fontSizePx: clampPx(
      o.fontSizePx ?? legacyFontSize,
      12,
      120,
      DEFAULT_CAPTION_SETTINGS.fontSizePx,
    ),
    bottomOffsetPx,
    wordHighlight: o.wordHighlight !== false,
    timingOffsetMs: clampMs(o.timingOffsetMs, -1500, 1500, 0),
  };
}

/** Hex for `<input type="color">` when value may be rgba or shorthand. */
export function captionColorPickerValue(value: string | null | undefined, fallbackHex: string): string {
  const v = value?.trim();
  if (!v) return fallbackHex;
  if (v.startsWith("#") && v.length === 4) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  if (v.startsWith("#") && /^#[0-9a-fA-F]{6}$/.test(v)) {
    return v;
  }
  return fallbackHex;
}

/** Paint color for the swatch preview (supports hex + rgb/rgba). */
export function captionSwatchColor(value: string | null | undefined, fallbackHex: string): string {
  const v = value?.trim();
  if (!v) return fallbackHex;
  if (v.startsWith("#") || v.startsWith("rgb")) return v;
  return captionColorPickerValue(v, fallbackHex);
}
