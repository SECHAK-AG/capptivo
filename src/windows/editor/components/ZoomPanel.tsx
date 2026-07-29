/**
 * Zoom inspector panel — desktop analog of the web editor's `EditorZoomPanel`.
 */

import { useCallback, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  getCompositionLayout,
  getFaceCamZoomPresenceMinScale,
  getShrinkFaceCamDuringZoom,
  hitTestHandle,
  MIN_FACE_CAM_ZOOM_PRESENCE_SCALE,
  scaleFromFixedRect,
  type RecordingMetadata,
  type ZoomFragment,
} from "@/engine";

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

import { resolveRecordingLayoutParams, type VideoLayoutFrac } from "../lib/composition";
import { useStageDimensions } from "../lib/useStageDimensions";
import { cornerHandleOverlayStyle, CROP_HANDLE_SIZE, getHandleCursor } from "../lib/cropHandles";
import { formatTimelineTime } from "../lib/timelineMath";
import { useEditorStore } from "../store";
import { InspectorVideoPreview } from "./InspectorVideoPreview";

type NormRect = { x: number; y: number; width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };

const MIN_ZOOM_RECT_RATIO = 0.08;
const DEFAULT_FIXED_RECT: NormRect = { x: 0.3, y: 0.25, width: 0.4, height: 0.5 };

/** Clamp fixed-rect in composition / stage NDC (full canvas including background). */
function clampZoomFixedRect(rect: NormRect): NormRect {
  const width = Math.max(MIN_ZOOM_RECT_RATIO, Math.min(1, rect.width));
  const height = Math.max(MIN_ZOOM_RECT_RATIO, Math.min(1, rect.height));
  const x = Math.max(0, Math.min(1 - width, rect.x));
  const y = Math.max(0, Math.min(1 - height, rect.y));
  return { x, y, width, height };
}

type Interaction =
  | { mode: "move"; startX: number; startY: number; startRect: Rect }
  | { mode: "resize"; handle: string; startX: number; startY: number; startRect: Rect };

export type ZoomPanelProps = {
  visible: boolean;
  screenUrl: string | null;
  recordingMetadata: RecordingMetadata | null;
  zoomFragments: ZoomFragment[];
  selectedZoomFragmentId: string | null;
  onSelectZoomFragmentId: (id: string) => void;
  updateSelectedZoomFragment: (updater: (current: ZoomFragment) => ZoomFragment) => void;
};

export function ZoomPanel({
  visible,
  screenUrl,
  recordingMetadata,
  zoomFragments,
  selectedZoomFragmentId,
  onSelectZoomFragmentId,
  updateSelectedZoomFragment,
}: ZoomPanelProps) {
  const { t } = useI18n();
  const cameraUrl = useEditorStore((s) => s.cameraUrl);
  const look = useEditorStore((s) => s.look);
  const selectedBackground = useEditorStore((s) => s.selectedBackground);
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const screenContentCrop = useEditorStore((s) => s.screenContentCrop);
  const aspectRatioPresetId = useEditorStore((s) => s.aspectRatioPresetId);
  const sourceAspect = useEditorStore((s) => s.sourceAspect);
  const sourceVideoSize = useEditorStore((s) => s.sourceVideoSize);

  // Interaction bounds = full composition stage (bg + recording).
  const stageRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [hoverCursor, setHoverCursor] = useState("default");

  const selectedZoomFragment = useMemo(
    () => zoomFragments.find((f) => f.id === selectedZoomFragmentId) ?? null,
    [zoomFragments, selectedZoomFragmentId],
  );

  const sortedZoomFragments = useMemo(
    () =>
      [...zoomFragments].sort(
        (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
      ),
    [zoomFragments],
  );

  const selectedZoomFixedRect = useMemo(
    () =>
      selectedZoomFragment?.mode === "fixed-rect"
        ? clampZoomFixedRect(selectedZoomFragment.fixedRect ?? DEFAULT_FIXED_RECT)
        : null,
    [selectedZoomFragment],
  );

  const selectedZoomEffectiveScale =
    selectedZoomFragment?.mode === "fixed-rect" && selectedZoomFixedRect
      ? scaleFromFixedRect(selectedZoomFixedRect)
      : selectedZoomFragment?.targetScale ?? 1;

  const { width: compW, height: compH } = useStageDimensions();

  const hasSelectedBackground = selectedBackground !== null;
  const hasImageBackground = hasSelectedBackground && backgroundType === "image";

  const videoLayoutPct = useMemo(() => {
    const { sourceAspect: layoutAspect, devicePadding } = resolveRecordingLayoutParams({
      presetId: aspectRatioPresetId,
      sourceAspect,
      sourceVideoSize,
      hasSelectedBackground,
      hasImageBackground,
      devicePadding: look.devicePadding,
      screenContentCrop,
    });
    const { video } = getCompositionLayout(layoutAspect, compW, compH, devicePadding);
    const frac: VideoLayoutFrac = {
      x: video.x / compW,
      y: video.y / compH,
      width: video.width / compW,
      height: video.height / compH,
    };
    return {
      left: frac.x * 100,
      top: frac.y * 100,
      width: frac.width * 100,
      height: frac.height * 100,
      radiusX: Math.min(look.cornerRadius, video.width / 2) / video.width * 100,
      radiusY: Math.min(look.cornerRadius, video.height / 2) / video.height * 100,
    };
  }, [
    aspectRatioPresetId,
    sourceAspect,
    sourceVideoSize,
    hasSelectedBackground,
    hasImageBackground,
    look.devicePadding,
    look.cornerRadius,
    screenContentCrop,
    compW,
    compH,
  ]);

  const crop = screenContentCrop;
  const videoCropStyle = useMemo((): CSSProperties | undefined => {
    if (!crop || crop.width <= 1e-6 || crop.height <= 1e-6) return undefined;
    return {
      position: "absolute",
      left: `${(-crop.x / crop.width) * 100}%`,
      top: `${(-crop.y / crop.height) * 100}%`,
      width: `${(1 / crop.width) * 100}%`,
      height: `${(1 / crop.height) * 100}%`,
      maxWidth: "none",
      objectFit: "fill",
    };
  }, [crop]);

  // Fixed-rect is composition / stage NDC (full canvas including background).
  const zoomRectToStagePx = useCallback(
    (rect: NormRect, bounds: { width: number; height: number }): Rect => ({
      x: rect.x * bounds.width,
      y: rect.y * bounds.height,
      width: rect.width * bounds.width,
      height: rect.height * bounds.height,
    }),
    [],
  );

  const stagePxToZoomRect = useCallback(
    (rectPx: Rect, bounds: { width: number; height: number }): NormRect =>
      clampZoomFixedRect({
        x: rectPx.x / bounds.width,
        y: rectPx.y / bounds.height,
        width: rectPx.width / bounds.width,
        height: rectPx.height / bounds.height,
      }),
    [],
  );

  const handlePointerDown = (e: ReactPointerEvent) => {
    if (!selectedZoomFragment || !selectedZoomFixedRect || !stageRef.current) {
      return;
    }

    const stage = stageRef.current;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const localX = e.clientX - bounds.left;
    const localY = e.clientY - bounds.top;
    const rectPx = zoomRectToStagePx(selectedZoomFixedRect, bounds);

    const handle = hitTestHandle(localX, localY, rectPx, CROP_HANDLE_SIZE);
    const inside =
      localX >= rectPx.x && localX <= rectPx.x + rectPx.width && localY >= rectPx.y && localY <= rectPx.y + rectPx.height;

    if (!handle && !inside) {
      return;
    }

    stage.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    setHoverCursor(handle ? getHandleCursor(handle) : "move");

    interactionRef.current = handle
      ? { mode: "resize", handle, startX: localX, startY: localY, startRect: rectPx }
      : { mode: "move", startX: localX, startY: localY, startRect: rectPx };
  };

  const handlePointerMove = (e: ReactPointerEvent) => {
    if (!selectedZoomFragment || !stageRef.current) {
      return;
    }

    const stage = stageRef.current;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const localX = e.clientX - bounds.left;
    const localY = e.clientY - bounds.top;
    const inter = interactionRef.current;

    if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) {
      return;
    }

    if (!inter) {
      if (!selectedZoomFixedRect) {
        setHoverCursor("default");
        return;
      }

      const rectPx = zoomRectToStagePx(selectedZoomFixedRect, bounds);
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

      return;
    }

    let nextRectPx: Rect;

    if (inter.mode === "move") {
      const dx = localX - inter.startX;
      const dy = localY - inter.startY;
      nextRectPx = {
        x: inter.startRect.x + dx,
        y: inter.startRect.y + dy,
        width: inter.startRect.width,
        height: inter.startRect.height,
      };
      setHoverCursor("grabbing");
    } else {
      const dx = localX - inter.startX;
      const dy = localY - inter.startY;
      const { startRect, handle } = inter;
      let x = startRect.x;
      let y = startRect.y;
      let w = startRect.width;
      let h = startRect.height;

      if (handle.includes("e")) w = startRect.width + dx;
      if (handle.includes("w")) {
        x = startRect.x + dx;
        w = startRect.width - dx;
      }
      if (handle.includes("s")) h = startRect.height + dy;
      if (handle.includes("n")) {
        y = startRect.y + dy;
        h = startRect.height - dy;
      }

      nextRectPx = { x, y, width: w, height: h };
      setHoverCursor(getHandleCursor(handle));
    }

    const nextFixedRect = stagePxToZoomRect(nextRectPx, bounds);
    updateSelectedZoomFragment((fragment) => ({
      ...fragment,
      fixedMode: "target",
      fixedRect: nextFixedRect,
      targetScale: scaleFromFixedRect(nextFixedRect),
    }));
  };

  const handlePointerUp = (e: ReactPointerEvent) => {
    if (e.pointerId !== pointerIdRef.current) {
      return;
    }

    if (stageRef.current?.hasPointerCapture(e.pointerId)) {
      stageRef.current.releasePointerCapture(e.pointerId);
    }

    pointerIdRef.current = null;
    interactionRef.current = null;
    setHoverCursor(selectedZoomFixedRect ? "move" : "default");
  };

  return (
    <div className={cn("flex flex-col gap-4", !visible && "hidden")}>
      {zoomFragments.length === 0 && (
        <p className="text-sm leading-relaxed text-muted-foreground">{t("zoom.empty.body")}</p>
      )}

      {zoomFragments.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="inspector-zoom-fragment" className="text-muted-foreground">
            {t("zoom.fragment.label")}
          </Label>
          <Select
            value={
              selectedZoomFragmentId && sortedZoomFragments.some((f) => f.id === selectedZoomFragmentId)
                ? selectedZoomFragmentId
                : undefined
            }
            onValueChange={onSelectZoomFragmentId}
          >
            <SelectTrigger id="inspector-zoom-fragment" className="h-9 w-full">
              <SelectValue placeholder={t("zoom.fragment.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {sortedZoomFragments.map((f, index) => (
                <SelectItem key={f.id} value={f.id}>
                  {`${index + 1}. ${formatTimelineTime(f.start)} – ${formatTimelineTime(f.end)}`}
                  {` · ${f.mode === "follow-cursor" ? t("zoom.tag.follow") : t("zoom.tag.fixed")}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {selectedZoomFragment && (
        <div className="space-y-4 pt-1">
          {recordingMetadata && recordingMetadata.cursorSamples.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("zoom.position")}</Label>
              <div className="inline-flex w-full items-center rounded-xl bg-muted p-1">
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    selectedZoomFragment.mode === "follow-cursor"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => updateSelectedZoomFragment((fragment) => ({ ...fragment, mode: "follow-cursor" }))}
                >
                  {t("zoom.tag.follow")}
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    selectedZoomFragment.mode === "fixed-rect"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() =>
                    updateSelectedZoomFragment((fragment) => ({
                      ...fragment,
                      mode: "fixed-rect",
                      fixedMode: "target",
                      fixedRect: fragment.fixedRect ?? { ...DEFAULT_FIXED_RECT },
                    }))
                  }
                >
                  {t("zoom.tag.fixed")}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("zoom.position")}</Label>
              <div className="inline-flex w-full items-center rounded-xl bg-muted p-1">
                <div className="flex-1 rounded-lg bg-background px-3 py-1.5 text-center text-sm font-medium text-foreground shadow-sm">
                  {t("zoom.tag.fixed")}
                </div>
              </div>
            </div>
          )}

          {cameraUrl && (
            <div className="flex items-center justify-between gap-3">
              <FieldLabelWithHint
                htmlFor="zoom-shrink-facecam"
                hint={t("zoom.shrinkFaceCam.hint")}
              >
                {t("zoom.shrinkFaceCam")}
              </FieldLabelWithHint>
              <Switch
                id="zoom-shrink-facecam"
                checked={getShrinkFaceCamDuringZoom(selectedZoomFragment)}
                onCheckedChange={(checked) =>
                  updateSelectedZoomFragment((fragment) => ({
                    ...fragment,
                    shrinkFaceCamDuringZoom: checked,
                  }))
                }
              />
            </div>
          )}

          {cameraUrl && getShrinkFaceCamDuringZoom(selectedZoomFragment) && (
            <div className="space-y-2">
              <FieldLabelWithHint
                htmlFor="zoom-facecam-size"
                hint={t("zoom.faceCamSize.hint")}
              >
                {t("zoom.faceCamSize")}
              </FieldLabelWithHint>
              <Slider
                id="zoom-facecam-size"
                min={Math.round(MIN_FACE_CAM_ZOOM_PRESENCE_SCALE * 100)}
                max={100}
                step={5}
                value={[Math.round(getFaceCamZoomPresenceMinScale(selectedZoomFragment) * 100)]}
                onValueChange={([value]) =>
                  updateSelectedZoomFragment((fragment) => ({
                    ...fragment,
                    faceCamZoomPresenceScale: Math.max(
                      MIN_FACE_CAM_ZOOM_PRESENCE_SCALE,
                      Math.min(1, (Number(value) || 62) / 100),
                    ),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t("zoom.faceCamSize.caption", {
                  percent: Math.round(getFaceCamZoomPresenceMinScale(selectedZoomFragment) * 100),
                })}
              </p>
            </div>
          )}

          {selectedZoomFragment.mode === "fixed-rect" && selectedZoomFixedRect && (
            <div className="space-y-2">
              <FieldLabelWithHint
                className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
                hint={t("zoom.referenceFrame.hint")}
              >
                {t("zoom.referenceFrame")}
              </FieldLabelWithHint>
              {/*
                9999px "outside" dim must live inside overflow-hidden (see screen crop) or it
                covers the whole inspector. Handles sit on a sibling so they stay unclipped.
              */}
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
                style={{ aspectRatio: `${compW} / ${compH}`, cursor: hoverCursor }}
              >
                <div className="absolute inset-0 overflow-hidden rounded-none bg-muted">
                  {selectedBackground && (
                    <>
                      <div
                        aria-hidden
                        className="absolute inset-0"
                        style={{
                          backgroundImage: `url("${selectedBackground}")`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          transform: look.backgroundBlur > 0 ? "scale(1.12)" : undefined,
                          filter:
                            look.backgroundBlur > 0
                              ? `blur(${Math.min(24, look.backgroundBlur)}px)`
                              : undefined,
                        }}
                      />
                      {look.backgroundDarkness > 0 && (
                        <div
                          aria-hidden
                          className="absolute inset-0"
                          style={{
                            backgroundColor: `rgba(0,0,0,${Math.min(100, look.backgroundDarkness) / 100})`,
                          }}
                        />
                      )}
                    </>
                  )}
                  <div
                    className="absolute overflow-hidden"
                    style={{
                      left: `${videoLayoutPct.left}%`,
                      top: `${videoLayoutPct.top}%`,
                      width: `${videoLayoutPct.width}%`,
                      height: `${videoLayoutPct.height}%`,
                      borderRadius: `${videoLayoutPct.radiusX}% / ${videoLayoutPct.radiusY}%`,
                    }}
                  >
                    {screenUrl ? (
                      videoCropStyle ? (
                        <div className="absolute inset-0 overflow-hidden">
                          <InspectorVideoPreview
                            src={screenUrl}
                            seekTo={selectedZoomFragment.start}
                            className="h-full w-full"
                            style={videoCropStyle}
                          />
                        </div>
                      ) : (
                        <InspectorVideoPreview
                          src={screenUrl}
                          seekTo={selectedZoomFragment.start}
                          className="h-full w-full object-cover"
                        />
                      )
                    ) : (
                      <div className="h-full w-full bg-muted" />
                    )}
                  </div>
                  <div
                    className="pointer-events-none absolute border-2 border-primary"
                    style={{
                      left: `${selectedZoomFixedRect.x * 100}%`,
                      top: `${selectedZoomFixedRect.y * 100}%`,
                      width: `${selectedZoomFixedRect.width * 100}%`,
                      height: `${selectedZoomFixedRect.height * 100}%`,
                      boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.4)",
                    }}
                  />
                </div>
                <div className="absolute inset-0 z-10">
                  {(["nw", "ne", "se", "sw"] as const).map((handle) => (
                    <div
                      key={handle}
                      className="pointer-events-none absolute rounded-none border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                      style={cornerHandleOverlayStyle(selectedZoomFixedRect, handle, CROP_HANDLE_SIZE)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {selectedZoomFragment.mode === "follow-cursor" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <FieldLabelWithHint htmlFor="zoom-scale" hint={t("zoom.scale.hint")}>
                  {t("zoom.scale")}
                </FieldLabelWithHint>
                <div className="space-y-1">
                  <Slider
                    id="zoom-scale"
                    className="mt-2"
                    min={1}
                    max={3}
                    step={0.05}
                    value={[selectedZoomEffectiveScale]}
                    onValueChange={([value]) =>
                      updateSelectedZoomFragment((fragment) => ({
                        ...fragment,
                        targetScale: Math.max(1, Math.min(3, Number(value) || 1)),
                      }))
                    }
                  />
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {selectedZoomEffectiveScale.toFixed(2)}x
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <FieldLabelWithHint
                  htmlFor="zoom-follow-pan-smoothness"
                  hint={t("zoom.panSmoothness.hint")}
                >
                  {t("zoom.panSmoothness")}
                </FieldLabelWithHint>
                <div className="space-y-1">
                  <Slider
                    id="zoom-follow-pan-smoothness"
                    className="mt-2"
                    min={1}
                    max={20}
                    step={1}
                    value={[Math.round(selectedZoomFragment.damping ?? 4)]}
                    onValueChange={([value]) =>
                      updateSelectedZoomFragment((fragment) => ({
                        ...fragment,
                        damping: Math.max(1, Math.min(20, Math.round(Number(value) || 4))),
                      }))
                    }
                  />
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {Math.round(selectedZoomFragment.damping ?? 4)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <FieldLabelWithHint htmlFor="zoom-ease-in" hint={t("zoom.easeIn.hint")}>
                {t("zoom.easeIn")}
              </FieldLabelWithHint>
              <div className="space-y-1">
                <Slider
                  id="zoom-ease-in"
                  className="mt-2"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={[selectedZoomFragment.easeIn]}
                  onValueChange={([value]) =>
                    updateSelectedZoomFragment((fragment) => ({
                      ...fragment,
                      easeIn: Math.max(0.1, Math.min(2, Number(value) || 0.1)),
                    }))
                  }
                />
                <div className="text-xs text-muted-foreground tabular-nums">
                  {selectedZoomFragment.easeIn.toFixed(2)}s
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabelWithHint htmlFor="zoom-ease-out" hint={t("zoom.easeOut.hint")}>
                {t("zoom.easeOut")}
              </FieldLabelWithHint>
              <div className="space-y-1">
                <Slider
                  id="zoom-ease-out"
                  className="mt-2"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={[selectedZoomFragment.easeOut]}
                  onValueChange={([value]) =>
                    updateSelectedZoomFragment((fragment) => ({
                      ...fragment,
                      easeOut: Math.max(0.1, Math.min(2, Number(value) || 0.1)),
                    }))
                  }
                />
                <div className="text-xs text-muted-foreground tabular-nums">
                  {selectedZoomFragment.easeOut.toFixed(2)}s
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
