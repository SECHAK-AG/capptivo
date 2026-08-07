import { useCallback, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { clampBlurRegion, type BlurRegion } from "@/engine";

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

type BlurRegionsPanelProps = {
  videoUrl: string;
  fileAspect?: number;
  disabled?: boolean;
  regions: BlurRegion[];
  onAdd: () => void;
  onChange: (id: string, patch: Partial<Omit<BlurRegion, "id">>) => void;
  onRemove: (id: string) => void;
  seekTo?: number;
  className?: string;
};

export function BlurRegionsPanel({
  videoUrl,
  fileAspect,
  disabled = false,
  regions,
  onAdd,
  onChange,
  onRemove,
  seekTo,
  className,
}: BlurRegionsPanelProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);

  const stageAspect = fileAspect ?? measuredAspect ?? 16 / 9;
  const selected = regions.find((r) => r.id === selectedId) ?? null;

  const pick = useCallback(
    (x: number, y: number, w: number, h: number): RectHit | null => {
      if (selected) {
        const handle = hitHandleAt(x, y, selected, w, h);
        if (handle) return { key: selected.id, rect: selected, handle };
      }
      const hit = [...regions]
        .reverse()
        .find((region) => containsPoint(x, y, region, w, h));
      return hit ? { key: hit.id, rect: hit, handle: null } : null;
    },
    [regions, selected],
  );

  const { cursor, handlers } = useRectDrag({
    stageRef,
    disabled,
    pick,
    onPick: setSelectedId,
    onChange: (id, next) => onChange(id, clampBlurRegion({ id, ...next })),
  });

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabelWithHint
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
        hint={t("blur.hint")}
      >
        {t("blur.label")}
      </FieldLabelWithHint>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onAdd}
        >
          {t("blur.add")}
        </Button>
        {selected && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onRemove(selected.id);
              setSelectedId(null);
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            {t("blur.remove")}
          </Button>
        )}
      </div>

      {regions.length > 0 && (
        <div
          ref={stageRef}
          className="relative w-full select-none"
          {...handlers}
          style={{ aspectRatio: stageAspect > 0 ? stageAspect : 16 / 9, cursor }}
        >
          <div className="absolute inset-0 overflow-hidden bg-muted">
            <InspectorVideoPreview
              src={videoUrl}
              seekTo={seekTo}
              className="h-full w-full object-contain"
              onAspect={fileAspect === undefined ? setMeasuredAspect : undefined}
            />
            {regions.map((region) => (
              <div
                key={region.id}
                className={cn(
                  "pointer-events-none absolute border-2",
                  region.id === selectedId
                    ? "border-primary"
                    : "border-primary/40",
                )}
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`,
                  height: `${region.height * 100}%`,
                  backdropFilter: "blur(6px)",
                }}
              />
            ))}
          </div>
          {selected && (
            <div className="absolute inset-0 z-10">
              {(["nw", "ne", "se", "sw"] as const).map((h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                  style={cornerHandleOverlayStyle(selected, h, CROP_HANDLE_SIZE)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
