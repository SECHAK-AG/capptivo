/**
 * Caption styling — layout matches web `EditorCaptionsPanel` (post-transcript section).
 */

import { Button } from "@/components/ui/button";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  CAPTION_FONT_OPTIONS,
  captionColorPickerValue,
  captionSwatchColor,
  DEFAULT_CAPTION_SETTINGS,
  type CaptionSettings,
} from "@/captions/settings";

type Props = {
  captionSettings: CaptionSettings;
  hasCaptions: boolean;
  /** False when cues came from SRT-only (no per-word Whisper timings). */
  wordTimingsAvailable: boolean;
  onChange: (patch: Partial<CaptionSettings>) => void;
};

function ColorSwatch({
  ariaLabel,
  value,
  fallbackHex,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  fallbackHex: string;
  onChange: (hex: string) => void;
}) {
  const picker = captionColorPickerValue(value, fallbackHex);
  const swatch = captionSwatchColor(value, fallbackHex);
  return (
    <label className="relative block h-8 w-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/40 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]">
      <span
        className="pointer-events-none absolute inset-0 block"
        style={{ backgroundColor: swatch }}
        aria-hidden
      />
      <input
        type="color"
        aria-label={ariaLabel}
        className="absolute inset-0 h-full w-full min-h-8 min-w-12 cursor-pointer opacity-0"
        value={picker}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function CaptionStyleControls({
  captionSettings,
  hasCaptions,
  wordTimingsAvailable,
  onChange,
}: Props) {
  if (!hasCaptions) return null;

  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <Switch
          id="captions-enabled"
          checked={captionSettings.enabled}
          onCheckedChange={(on) => onChange({ enabled: on })}
        />
        <div className="min-w-0 flex-1">
          <FieldLabelWithHint
            htmlFor="captions-enabled"
            className="text-sm font-normal text-foreground"
            hint="Turns subtitles on or off on the video."
          >
            Show captions
          </FieldLabelWithHint>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="captions-word-follow"
          checked={captionSettings.wordHighlight}
          disabled={!wordTimingsAvailable}
          onCheckedChange={(on) => onChange({ wordHighlight: on })}
        />
        <div className="min-w-0 flex-1">
          <FieldLabelWithHint
            htmlFor="captions-word-follow"
            className="text-sm font-normal text-foreground"
            hint="Highlights the word being spoken using Whisper token timings (not estimated splits)."
          >
            Follow spoken word
          </FieldLabelWithHint>
        </div>
      </div>
      {!wordTimingsAvailable ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Word follow needs JSON from whisper-cli (<code className="text-[10px]">-ojf</code>
          ). SRT-only transcripts still show full phrases.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabelWithHint
            className="text-xs"
            hint="Background behind a full line. Clear removes it so only highlighted words stand out."
          >
            Sentence background
          </FieldLabelWithHint>
          <div className="flex gap-1">
            <ColorSwatch
              ariaLabel="Sentence background color"
              value={captionSettings.sentenceBackground ?? "#18181b"}
              fallbackHex="#18181b"
              onChange={(hex) => onChange({ sentenceBackground: hex })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => onChange({ sentenceBackground: null })}
            >
              Clear
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <FieldLabelWithHint className="text-xs" hint="Background behind the word currently being spoken.">
            Highlight color
          </FieldLabelWithHint>
          <div className="flex gap-1">
            <ColorSwatch
              ariaLabel="Word highlight color"
              value={captionSettings.wordBackground ?? "#c8ff3d"}
              fallbackHex="#c8ff3d"
              onChange={(hex) => onChange({ wordBackground: hex })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => onChange({ wordBackground: null })}
            >
              Clear
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabelWithHint
            htmlFor="cap-sent-r"
            className="text-xs"
            hint="Rounded corners on the full-line caption background."
          >
            Sentence radius (px)
          </FieldLabelWithHint>
          <Slider
            id="cap-sent-r"
            min={0}
            max={48}
            step={1}
            value={[captionSettings.sentenceRadiusPx]}
            onValueChange={([v]) => onChange({ sentenceRadiusPx: v })}
          />
        </div>
        <div className="space-y-1">
          <FieldLabelWithHint
            htmlFor="cap-word-r"
            className="text-xs"
            hint="Rounded corners on each highlighted word bubble."
          >
            Word radius (px)
          </FieldLabelWithHint>
          <Slider
            id="cap-word-r"
            min={0}
            max={48}
            step={1}
            value={[captionSettings.wordRadiusPx]}
            onValueChange={([v]) => onChange({ wordRadiusPx: v })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabelWithHint className="text-xs" hint="Color for most of the subtitle text.">
            Text color
          </FieldLabelWithHint>
          <div className="flex min-h-8 items-center">
            <ColorSwatch
              ariaLabel="Text color"
              value={captionSettings.textColor}
              fallbackHex="#ffffff"
              onChange={(hex) => onChange({ textColor: hex })}
            />
          </div>
        </div>
        <div className="space-y-1">
          <FieldLabelWithHint
            className="text-xs"
            hint="Text color for the current word when using a separate highlight color."
          >
            Word highlight text color
          </FieldLabelWithHint>
          <div className="flex gap-1">
            <ColorSwatch
              ariaLabel="Word highlight text color"
              value={captionSettings.wordTextColor ?? captionSettings.textColor}
              fallbackHex={captionSettings.textColor}
              onChange={(hex) => onChange({ wordTextColor: hex })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => onChange({ wordTextColor: null })}
            >
              Clear
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <FieldLabelWithHint htmlFor="cap-font" className="text-xs" hint="Subtitle typeface.">
          Font
        </FieldLabelWithHint>
        <Select
          value={captionSettings.fontFamily}
          onValueChange={(v) => onChange({ fontFamily: v })}
        >
          <SelectTrigger id="cap-font" className="h-9">
            <SelectValue placeholder="Font" />
          </SelectTrigger>
          <SelectContent>
            {CAPTION_FONT_OPTIONS.map((font) => (
              <SelectItem key={font.value} value={font.value}>
                {font.label}
                {font.value === DEFAULT_CAPTION_SETTINGS.fontFamily ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <FieldLabelWithHint
          htmlFor="cap-font-size"
          className="text-xs"
          hint="How large subtitles appear on the video."
        >
          Font size (px)
        </FieldLabelWithHint>
        <Slider
          id="cap-font-size"
          min={12}
          max={120}
          step={1}
          value={[captionSettings.fontSizePx]}
          onValueChange={([v]) => onChange({ fontSizePx: v })}
        />
      </div>

      <div className="space-y-1">
        <FieldLabelWithHint
          htmlFor="cap-bottom"
          className="text-xs"
          hint="Distance from the bottom edge. Higher moves captions up."
        >
          Bottom offset (px)
        </FieldLabelWithHint>
        <Slider
          id="cap-bottom"
          min={8}
          max={200}
          step={1}
          value={[captionSettings.bottomOffsetPx]}
          onValueChange={([v]) => onChange({ bottomOffsetPx: v })}
        />
      </div>

      <div className="space-y-1">
        <FieldLabelWithHint
          htmlFor="cap-timing-offset"
          className="text-xs"
          hint="If the highlight feels late or early vs the audio, nudge it (negative = earlier)."
        >
          Word sync offset ({captionSettings.timingOffsetMs} ms)
        </FieldLabelWithHint>
        <Slider
          id="cap-timing-offset"
          min={-1500}
          max={1500}
          step={10}
          disabled={!wordTimingsAvailable || !captionSettings.wordHighlight}
          value={[captionSettings.timingOffsetMs]}
          onValueChange={([v]) => onChange({ timingOffsetMs: v })}
        />
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs text-muted-foreground"
        onClick={() =>
          onChange({
            ...DEFAULT_CAPTION_SETTINGS,
            enabled: captionSettings.enabled,
            language: captionSettings.language,
          })
        }
      >
        Reset style
      </Button>
    </div>
  );
}
