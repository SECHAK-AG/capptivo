import { useCallback, useRef, useState } from "react";
import { clampScreenContentCropNorm, hitTestHandle, type ScreenContentCropNorm } from "@/engine";

import { Button } from "@/components/ui/button";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

import { cornerHandleOverlayStyle, CROP_HANDLE_SIZE, getHandleCursor } from "../lib/cropHandles";
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

type Interaction =
  | { mode: "move"; startX: number; startY: number; startRect: Rect }
  | { mode: "resize"; handle: string; startX: number; startY: number; startRect: Rect };

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
  const pointerIdRef = useRef<number | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [hoverCursor, setHoverCursor] = useState("default");
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const stageAspect = fileAspect ?? measuredAspect ?? 16 / 9;
  const activeRect = value ?? null;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || !hasBackground || !activeRect || !stageRef.current) {
      return;
    }

    const stage = stageRef.current;
    const b = stage.getBoundingClientRect();

    if (b.width <= 0 || b.height <= 0) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const localX = e.clientX - b.left;
    const localY = e.clientY - b.top;
    const rectPx: Rect = {
      x: activeRect.x * b.width,
      y: activeRect.y * b.height,
      width: activeRect.width * b.width,
      height: activeRect.height * b.height,
    };

    const handle = hitTestHandle(localX, localY, rectPx, CROP_HANDLE_SIZE);
    const inside =
      localX >= rectPx.x &&
      localX <= rectPx.x + rectPx.width &&
      localY >= rectPx.y &&
      localY <= rectPx.y + rectPx.height;

    if (!handle && !inside) {
      return;
    }

    stage.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;

    if (handle) {
      interactionRef.current = {
        mode: "resize",
        handle,
        startX: localX,
        startY: localY,
        startRect: { ...rectPx },
      };
    } else {
      interactionRef.current = {
        mode: "move",
        startX: localX,
        startY: localY,
        startRect: { ...rectPx },
      };
    }
  };

  const applyRectPx = useCallback(
    (r: Rect, w: number, h: number) => {
      const x = r.x / w;
      const y = r.y / h;
      const width = r.width / w;
      const height = r.height / h;
      onChange(clampScreenContentCropNorm({ x, y, width, height }));
    },
    [onChange],
  );

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!activeRect || !stageRef.current) {
      return;
    }

    const stage = stageRef.current;
    const b = stage.getBoundingClientRect();
    const localX = e.clientX - b.left;
    const localY = e.clientY - b.top;
    const bw = b.width;
    const bh = b.height;

    const inter = interactionRef.current;

    if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) {
      return;
    }

    if (inter) {
      if (inter.mode === "move") {
        const dx = localX - inter.startX;
        const dy = localY - inter.startY;
        applyRectPx(
          {
            x: inter.startRect.x + dx,
            y: inter.startRect.y + dy,
            width: inter.startRect.width,
            height: inter.startRect.height,
          },
          bw,
          bh,
        );
      } else {
        const dx = localX - inter.startX;
        const dy = localY - inter.startY;
        const { startRect, handle } = inter;
        let x = startRect.x;
        let y = startRect.y;
        let w = startRect.width;
        let h = startRect.height;

        if (handle.includes("e")) {
          w = startRect.width + dx;
        }

        if (handle.includes("w")) {
          x = startRect.x + dx;
          w = startRect.width - dx;
        }

        if (handle.includes("s")) {
          h = startRect.height + dy;
        }

        if (handle.includes("n")) {
          y = startRect.y + dy;
          h = startRect.height - dy;
        }

        applyRectPx({ x, y, width: w, height: h }, bw, bh);
      }

      return;
    }

    const rectPx: Rect = {
      x: activeRect.x * bw,
      y: activeRect.y * bh,
      width: activeRect.width * bw,
      height: activeRect.height * bh,
    };
    const hov = hitTestHandle(localX, localY, rectPx, CROP_HANDLE_SIZE);

    if (hov) {
      setHoverCursor(getHandleCursor(hov));
    } else if (
      localX >= rectPx.x &&
      localX <= rectPx.x + rectPx.width &&
      localY >= rectPx.y &&
      localY <= rectPx.y + rectPx.height
    ) {
      setHoverCursor("move");
    } else {
      setHoverCursor("default");
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (e.pointerId !== pointerIdRef.current) {
      return;
    }

    if (stageRef.current?.hasPointerCapture(e.pointerId)) {
      stageRef.current.releasePointerCapture(e.pointerId);
    }

    pointerIdRef.current = null;
    interactionRef.current = null;
  };

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
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={(e) => {
            if (!interactionRef.current) {
              setHoverCursor("default");
            }

            handlePointerUp(e);
          }}
          style={{
            aspectRatio: stageAspect > 0 ? stageAspect : 16 / 9,
            cursor: hoverCursor,
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
