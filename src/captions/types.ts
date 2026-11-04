/** Caption cue types — aligned with the web editor. */

export interface CaptionCueWord {
  text: string;
  startMs: number;
  endMs: number;
  leadingSpace?: boolean;
}

export interface CaptionCue {
  /** Optional per-caption centre in normalized composition coordinates. */
  anchor?: { x: number; y: number };
  /** User-authored text uses exact start/end boundaries, without speech hold. */
  manual?: boolean;
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: CaptionCueWord[];
}

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

export type { CaptionSettings, AutoCaptionSettings } from "./settings";
export {
  CAPTION_FONT_OPTIONS,
  DEFAULT_CAPTION_SETTINGS,
  DEFAULT_AUTO_CAPTION_SETTINGS,
  parseCaptionSettings,
  captionColorPickerValue,
  captionSwatchColor,
} from "./settings";
export { captionsHaveWordTimings, cueHasWordTimings } from "./captionTiming";

/** Payload shapes used by parser. */
export type CaptionCuePayload = CaptionCue;
export type CaptionWordPayload = CaptionCueWord;

export interface WhisperJsonToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

export interface WhisperJsonSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperJsonToken[];
}
