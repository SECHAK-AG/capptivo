import type { CaptionCue } from "./types";
import type { CaptionSettings } from "./settings";
import {
  playbackTimeMs,
  resolveActiveCueWords,
  type TimedDrawWord,
} from "./captionTiming";

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(Math.max(0, r), w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function measureLineWidth(
  ctx: CanvasRenderingContext2D,
  lineWords: TimedDrawWord[],
  spaceW: number,
) {
  let w = 0;
  for (let i = 0; i < lineWords.length; i += 1) {
    const segment = displayText(lineWords[i]!, i > 0);
    w += ctx.measureText(segment).width;
    if (i < lineWords.length - 1) w += spaceW;
  }
  return w;
}

function displayText(word: TimedDrawWord, withLeadingSpace: boolean): string {
  return `${withLeadingSpace && word.leadingSpace ? " " : ""}${word.text}`;
}

function wrapPhraseToLines(
  ctx: CanvasRenderingContext2D,
  phraseWords: TimedDrawWord[],
  maxWidth: number,
  spaceW: number,
): TimedDrawWord[][] {
  if (phraseWords.length === 0) return [];
  const lines: TimedDrawWord[][] = [];
  let line: TimedDrawWord[] = [];

  const flush = () => {
    if (line.length > 0) {
      lines.push(line);
      line = [];
    }
  };

  for (let i = 0; i < phraseWords.length; i += 1) {
    const w = phraseWords[i]!;
    const trial = [...line, w];
    const tw = measureLineWidth(
      ctx,
      trial.map((word, idx) => ({ ...word, leadingSpace: idx > 0 })),
      spaceW,
    );
    if (tw <= maxWidth || line.length === 0) {
      line = trial;
    } else {
      flush();
      line = [w];
    }
  }
  flush();
  return lines;
}

function fallbackWordsFromText(cue: CaptionCue): TimedDrawWord[] {
  return cue.text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text, i) => ({
      text,
      startSec: 0,
      endSec: 0,
      leadingSpace: i > 0,
    }));
}

/** Cached, time-independent layout for one cue at a given font + width. */
type CaptionLayout = {
  lines: TimedDrawWord[][];
  lineWidths: number[];
  /** Per-line, per-word rendered widths — matches the draw loop's segments. */
  wordWidths: number[][];
  blockInnerW: number;
  spaceW: number;
};

/** Bounds inner-map growth during e.g. a font-size drag; playback stays warm. */
const MAX_LAYOUTS_PER_CUE = 4;

// Keyed by cue identity, so entries drop automatically when captions are
// regenerated. The inner map holds the handful of (font, width) combos actually
// in play — typically just the preview size and the export size.
const layoutCache = new WeakMap<CaptionCue, Map<string, CaptionLayout>>();

/**
 * Line wrapping + width measurement for a cue, memoized. This is the expensive
 * part (O(words²) `measureText` in `wrapPhraseToLines`, plus per-word widths),
 * and it only changes when the cue, font, or available width change — never
 * per frame. The karaoke highlight (which word is lit) stays live in the caller.
 */
function getCaptionLayout(
  ctx: CanvasRenderingContext2D,
  cue: CaptionCue,
  layoutWords: TimedDrawWord[],
  fontSize: number,
  fontFamily: string,
  maxLineWidth: number,
): CaptionLayout {
  const key = `${fontSize}|${fontFamily}|${maxLineWidth}`;
  let byKey = layoutCache.get(cue);
  const cached = byKey?.get(key);
  if (cached) return cached;
  if (!byKey) {
    byKey = new Map();
    layoutCache.set(cue, byKey);
  }

  // `ctx.font` is set by the caller before this runs, so measurements are valid.
  const spaceW = ctx.measureText(" ").width;
  const lines = wrapPhraseToLines(ctx, layoutWords, maxLineWidth, spaceW);
  const lineWidths = lines.map((ln) => measureLineWidth(ctx, ln, spaceW));
  const wordWidths = lines.map((ln) =>
    ln.map((w, i) => ctx.measureText(displayText(w, i > 0)).width),
  );
  const blockInnerW = lineWidths.length > 0 ? Math.max(...lineWidths) : 0;
  const layout: CaptionLayout = { lines, lineWidths, wordWidths, blockInnerW, spaceW };

  if (byKey.size >= MAX_LAYOUTS_PER_CUE) byKey.clear();
  byKey.set(key, layout);
  return layout;
}

// Stable per-cue ids for `captionFrameKey`. Keyed by cue identity so entries
// drop when captions are regenerated.
const cueIds = new WeakMap<CaptionCue, number>();
let nextCueId = 1;

function cueId(cue: CaptionCue): number {
  let id = cueIds.get(cue);
  if (id === undefined) {
    id = nextCueId++;
    cueIds.set(cue, id);
  }
  return id;
}

/**
 * A key identifying the *pixels* `drawCaptions` would paint for this frame, or
 * `null` when it would paint nothing.
 *
 * Captions have no per-frame animation: within a cue the image only changes
 * when the karaoke highlight moves to the next word. The GPU compositor uses
 * this to keep the caption layer as a cached texture and re-upload it a handful
 * of times per second instead of once per frame.
 */
export function captionFrameKey(
  cues: CaptionCue[],
  settings: CaptionSettings,
  stageWidth: number,
  stageHeight: number,
  timeMs: number,
): string | null {
  if (!settings.enabled || cues.length === 0) return null;
  const resolved = resolveActiveCueWords(cues, playbackTimeMs(timeMs, settings.timingOffsetMs));
  if (!resolved) return null;
  return `${cueId(resolved.cue)}|${resolved.activeWordIndex}|${stageWidth}x${stageHeight}|${JSON.stringify(settings)}`;
}

/** Draw subtitles + karaoke word highlight (Whisper timings only; no synthetic word clock). */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  cues: CaptionCue[],
  settings: CaptionSettings,
  stageWidth: number,
  stageHeight: number,
  timeMs: number,
): void {
  if (!settings.enabled || cues.length === 0) return;

  const adjustedMs = playbackTimeMs(timeMs, settings.timingOffsetMs);
  const resolved = resolveActiveCueWords(cues, adjustedMs);
  if (!resolved) return;

  const { words: phraseWords, activeWordIndex } = resolved;
  const layoutWords =
    phraseWords.length > 0 ? phraseWords : fallbackWordsFromText(resolved.cue);
  if (layoutWords.length === 0) return;

  const karaokeOn =
    settings.wordHighlight &&
    settings.wordBackground !== null &&
    phraseWords.length > 0 &&
    activeWordIndex >= 0;

  const fontWeight = 600;
  const fontSize = settings.fontSizePx;
  const font = `${fontWeight} ${fontSize}px ${settings.fontFamily}`;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";

  const maxLineWidth = Math.max(120, Math.min(stageWidth * 0.86, stageWidth - 32));
  const { lines, lineWidths, wordWidths, blockInnerW, spaceW } = getCaptionLayout(
    ctx,
    resolved.cue,
    layoutWords,
    fontSize,
    settings.fontFamily,
    maxLineWidth,
  );
  if (lines.length === 0) {
    ctx.restore();
    return;
  }

  const lineGap = Math.round(fontSize * 0.2);
  const lineHeight = Math.round(fontSize * 1.28);
  const blockPadX = Math.max(14, Math.round(fontSize * 0.42));
  const blockPadY = Math.max(10, Math.round(fontSize * 0.32));
  const blockW = blockInnerW + blockPadX * 2;
  const blockH = lines.length * lineHeight + (lines.length - 1) * lineGap + blockPadY * 2;

  const blockLeft = (stageWidth - blockW) / 2;
  const blockTop = stageHeight - settings.bottomOffsetPx - blockH;

  const sentBg = settings.sentenceBackground;
  const wordBg = settings.wordBackground;
  const sentR = Math.max(0, settings.sentenceRadiusPx);
  const wordR = Math.max(0, settings.wordRadiusPx);

  if (sentBg) {
    ctx.save();
    ctx.fillStyle = sentBg;
    roundedRectPath(ctx, blockLeft, blockTop, blockW, blockH, sentR);
    ctx.fill();
    ctx.restore();
  }

  let flatIndex = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const lineWords = lines[li]!;
    const lw = lineWidths[li]!;
    const lineTop = blockTop + blockPadY + li * (lineHeight + lineGap);
    const textMidY = lineTop + lineHeight * 0.5;
    let x = blockLeft + (blockW - lw) / 2;

    for (let i = 0; i < lineWords.length; i += 1) {
      const w = lineWords[i]!;
      const segment = displayText(w, i > 0);
      const tw = wordWidths[li]![i]!;
      const isActive = karaokeOn && flatIndex === activeWordIndex;

      if (isActive && wordBg) {
        ctx.save();
        ctx.fillStyle = wordBg;
        const padWX = Math.max(3, fontSize * 0.12);
        const wordH = lineHeight * 0.88;
        const wordTop = textMidY - wordH * 0.5;
        roundedRectPath(ctx, x - padWX, wordTop, tw + padWX * 2, wordH, wordR);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.fillStyle = isActive
        ? (settings.wordTextColor ?? settings.textColor)
        : settings.textColor;
      ctx.fillText(segment, x, textMidY);
      ctx.restore();

      x += tw + spaceW;
      flatIndex += 1;
    }
  }

  ctx.restore();
}
