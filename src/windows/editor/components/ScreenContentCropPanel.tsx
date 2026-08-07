import { useCallback, useRef, useState } from "react";
import { clampScreenContentCropNorm, type ScreenContentCropNorm } from "@/engine";

import { Button } from "@/components/ui/button";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

import { cornerHandleOverlayStyle, CROP_HANDLE_SIZE } from "../lib/cropHandles";
import {
  containsPoint,
  hitHandleAt,
  useRectDrag,
  type RectHit,
} from "../lib/useRectDrag";
import { InspectorVideoPreview } from "./InspectorVideoPreview";

type Rect = { x: number; y: number; width: number; height: number };

const DEFAULT_CROP: ScreenContentCropNorm = { x: 0, y: 0, width: 1, height: 1 };

type ScreenContentCropPanelProps = {
  videoUrl: string;
  /**
   * Un-cropped file width ÷ height (drives the preview's aspect, like the
   * reference frame). Omit to self-measure from the video's metadata.
   */
  fileAspect?: number;
  hasBackground: boolean;
  disabled?: boolean;
  value: ScreenContentCropNorm | null;
  onChange: (next: ScreenContentCropNorm | null) => void;
  /** Playhead time so the crop preview shows the current frame. Omit while playing. */
  seekTo?: number;
  className?: string;
  /** Field label; defaults to the screen-recording crop copy. */
  label?: string;
  hint?: string;
};

/**
 * Single fixed crop (normalized 0–1) for the whole recording: which rectangle of the
 * source video is shown. Independent of zoom keyframes. Clearing the crop restores defaults.
 */
export function ScreenContentCropPanel({
  videoUrl,
  fileAspect,
  hasBackground,
  disabled = false,
  value,
  onChange,
  seekTo,
  className,
  label,
  hint,
}: ScreenContentCropPanelProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const stageAspect = fileAspect ?? measuredAspect ?? 16 / 9;
  const activeRect = value ?? null;

  const pick = useCallback(
    (x: number, y: number, w: number, h: number): RectHit | null => {
      if (!activeRect) return null;
      const handle = hitHandleAt(x, y, activeRect, w, h);
      if (handle) return { key: "crop", rect: activeRect, handle };
      return containsPoint(x, y, activeRect, w, h)
        ? { key: "crop", rect: activeRect, handle: null }
        : null;
    },
    [activeRect],
  );

  const { cursor, handlers } = useRectDrag({
    stageRef,
    disabled: disabled || !hasBackground,
    pick,
    onChange: (_key, next) => onChange(clampScreenContentCropNorm(next)),
  });

  if (!hasBackground) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabelWithHint
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
        hint={hint ?? t("crop.hint")}
      >
        {label ?? t("crop.label")}
      </FieldLabelWithHint>

      <div className="flex flex-wrap gap-2">
        {activeRect === null ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ ...DEFAULT_CROP })}
          >
            {t("crop.set")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            {t("crop.full")}
          </Button>
        )}
      </div>

      {activeRect && (
        <div
          ref={stageRef}
          className="relative w-full select-none"
          {...handlers}
          style={{
            aspectRatio: stageAspect > 0 ? stageAspect : 16 / 9,
            cursor,
          }}
        >
          {/*
            9999px "outside" dim must live inside overflow-hidden, or it shades the
            whole editor. Handles stay on a sibling with overflow visible.
          */}
          <div className="absolute inset-0 overflow-hidden rounded-none bg-muted">
            <InspectorVideoPreview
              src={videoUrl}
              seekTo={seekTo}
              className="h-full w-full object-contain"
              onAspect={fileAspect === undefined ? setMeasuredAspect : undefined}
            />
            <div
              className="pointer-events-none absolute border-2 border-primary"
              style={{
                left: `${activeRect.x * 100}%`,
                top: `${activeRect.y * 100}%`,
                width: `${activeRect.width * 100}%`,
                height: `${activeRect.height * 100}%`,
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.4)",
              }}
            />
          </div>
          <div className="absolute inset-0 z-10">
            {(["nw", "ne", "se", "sw"] as const).map((h) => (
              <div
                key={h}
                className="pointer-events-none absolute rounded-none border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                style={cornerHandleOverlayStyle(activeRect, h, CROP_HANDLE_SIZE)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
