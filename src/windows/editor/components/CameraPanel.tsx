/**
 * Face-cam overlay controls (Laravel `EditorCameraPanel` subset for desktop).
 */

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_FACE_CAM_MARGIN,
  FACE_CAM_COMPOSITION,
  FACE_CAM_MARGIN_MAX,
  FACE_CAM_MARGIN_MIN,
  FACE_CAM_ROUND_MAX,
  FACE_CAM_ROUND_MIN,
  type FaceCamCorner,
} from "@/engine";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useEditorStore, type FaceCamParams } from "../store";
import { ScreenContentCropPanel } from "./ScreenContentCropPanel";
import { SectionLabel } from "./ui";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Corner id → placement inside the mini-stage picker. */
const FACE_CAM_CORNER_OPTIONS: readonly { id: FaceCamCorner; className: string }[] = [
  { id: "top-left", className: "left-1.5 top-1.5" },
  { id: "top-right", className: "right-1.5 top-1.5" },
  { id: "bottom-left", className: "bottom-1.5 left-1.5" },
  { id: "bottom-right", className: "bottom-1.5 right-1.5" },
];

export function CameraPanel({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  const cameraUrl = useEditorStore((s) => s.cameraUrl);
  const faceCam = useEditorStore((s) => s.faceCam);
  const setFaceCam = useEditorStore((s) => s.setFaceCam);
  // Freeze preview frame while playing — continuous seeks thrash media:// decode.
  const cropPreviewTime = useEditorStore((s) =>
    s.isPlaying ? undefined : s.currentTime,
  );
  const hasFaceCam = !!cameraUrl;

  const set = <K extends keyof FaceCamParams>(key: K, value: FaceCamParams[K]) => {
    setFaceCam({ [key]: value } as Partial<FaceCamParams>);
  };

  return (
    <div className={cn("flex flex-col gap-6", !visible && "hidden")}>
      {!hasFaceCam ? (
        <p className="text-xs text-muted-foreground">{t("camera.noTrack")}</p>
      ) : null}

      <section className="space-y-4">
        <SectionLabel>{t("camera.section")}</SectionLabel>

        <div className="flex items-center justify-between gap-3">
          <FieldLabelWithHint htmlFor="facecam-round" hint={t("camera.round.hint")}>
            {t("camera.round")}
          </FieldLabelWithHint>
          <Switch
            id="facecam-round"
            checked={faceCam.isRound}
            disabled={!hasFaceCam}
            onCheckedChange={(isRound) => {
              if (isRound) {
                const size = clamp(
                  Math.max(faceCam.widthPx, faceCam.heightPx),
                  FACE_CAM_ROUND_MIN,
                  FACE_CAM_ROUND_MAX,
                );
                setFaceCam({ isRound: true, widthPx: size, heightPx: size });
              } else {
                set("isRound", false);
              }
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <FieldLabelWithHint htmlFor="facecam-mirror" hint={t("camera.mirror.hint")}>
            {t("camera.mirror")}
          </FieldLabelWithHint>
          <Switch
            id="facecam-mirror"
            checked={faceCam.mirrored}
            disabled={!hasFaceCam}
            onCheckedChange={(mirrored) => set("mirrored", mirrored)}
          />
        </div>

        <div className="space-y-2">
          <FieldLabelWithHint hint={t("camera.position.hint")}>
            {t("camera.position")}
          </FieldLabelWithHint>
          {/* Mini stage: same shape as the canvas, one PiP-shaped chip per corner. */}
          <div
            role="radiogroup"
            aria-label={t("camera.position")}
            className="relative aspect-video w-full max-w-60 rounded-lg border border-border bg-muted/40"
          >
            {FACE_CAM_CORNER_OPTIONS.map(({ id, className }) => {
              const selected = faceCam.corner === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={t(`camera.position.${id}`)}
                  title={t(`camera.position.${id}`)}
                  disabled={!hasFaceCam}
                  onClick={() => setFaceCam({ corner: id, position: null })}
                  className={cn(
                    "absolute cursor-pointer border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    faceCam.isRound ? "size-6 rounded-full" : "h-6 w-8 rounded-[5px]",
                    className,
                    selected
                      ? "border-primary bg-primary"
                      : "border-border bg-background hover:border-primary/60 hover:bg-primary/15",
                    !hasFaceCam && "cursor-not-allowed opacity-40",
                  )}
                />
              );
            })}
          </div>
        </div>

        {faceCam.isRound ? (
          <div className="space-y-2">
            <FieldLabelWithHint htmlFor="facecam-size" hint={t("camera.size.hint")}>
              {t("camera.size")}
            </FieldLabelWithHint>
            <Slider
              id="facecam-size"
              min={FACE_CAM_ROUND_MIN}
              max={FACE_CAM_ROUND_MAX}
              step={10}
              disabled={!hasFaceCam}
              value={[clamp(faceCam.widthPx, FACE_CAM_ROUND_MIN, FACE_CAM_ROUND_MAX)]}
              onValueChange={([v]) => {
                const size = clamp(v ?? faceCam.widthPx, FACE_CAM_ROUND_MIN, FACE_CAM_ROUND_MAX);
                setFaceCam({ widthPx: size, heightPx: size });
              }}
            />
            <div className="text-xs tabular-nums text-muted-foreground">
              {Math.round(clamp(faceCam.widthPx, FACE_CAM_ROUND_MIN, FACE_CAM_ROUND_MAX))} px
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <FieldLabelWithHint htmlFor="facecam-width" hint={t("camera.width.hint")}>
                {t("camera.width")}
              </FieldLabelWithHint>
              <Slider
                id="facecam-width"
                min={FACE_CAM_COMPOSITION.minWidth}
                max={FACE_CAM_COMPOSITION.maxWidth}
                step={10}
                disabled={!hasFaceCam}
                value={[faceCam.widthPx]}
                onValueChange={([v]) =>
                  set(
                    "widthPx",
                    clamp(v ?? faceCam.widthPx, FACE_CAM_COMPOSITION.minWidth, FACE_CAM_COMPOSITION.maxWidth),
                  )
                }
              />
              <div className="text-xs tabular-nums text-muted-foreground">{Math.round(faceCam.widthPx)} px</div>
            </div>
            <div className="space-y-2">
              <FieldLabelWithHint htmlFor="facecam-height" hint={t("camera.height.hint")}>
                {t("camera.height")}
              </FieldLabelWithHint>
              <Slider
                id="facecam-height"
                min={FACE_CAM_COMPOSITION.minHeight}
                max={FACE_CAM_COMPOSITION.maxHeight}
                step={10}
                disabled={!hasFaceCam}
                value={[faceCam.heightPx]}
                onValueChange={([v]) =>
                  set(
                    "heightPx",
                    clamp(v ?? faceCam.heightPx, FACE_CAM_COMPOSITION.minHeight, FACE_CAM_COMPOSITION.maxHeight),
                  )
                }
              />
              <div className="text-xs tabular-nums text-muted-foreground">{Math.round(faceCam.heightPx)} px</div>
            </div>
          </>
        )}

        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="facecam-margin" hint={t("camera.margin.hint")}>
            {t("camera.margin")}
          </FieldLabelWithHint>
          <Slider
            id="facecam-margin"
            min={FACE_CAM_MARGIN_MIN}
            max={FACE_CAM_MARGIN_MAX}
            step={1}
            disabled={!hasFaceCam}
            value={[faceCam.marginPx ?? DEFAULT_FACE_CAM_MARGIN]}
            onValueChange={([v]) =>
              set(
                "marginPx",
                clamp(v ?? DEFAULT_FACE_CAM_MARGIN, FACE_CAM_MARGIN_MIN, FACE_CAM_MARGIN_MAX),
              )
            }
          />
          <div className="text-xs tabular-nums text-muted-foreground">
            {Math.round(faceCam.marginPx ?? DEFAULT_FACE_CAM_MARGIN)} px
          </div>
        </div>

        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="facecam-shadow" hint={t("camera.shadow.hint")}>
            {t("camera.shadow")}
          </FieldLabelWithHint>
          <Slider
            id="facecam-shadow"
            min={0}
            max={200}
            step={1}
            disabled={!hasFaceCam}
            value={[faceCam.shadowIntensity]}
            onValueChange={([v]) => set("shadowIntensity", clamp(v ?? 0, 0, 200))}
          />
        </div>

        {!faceCam.isRound ? (
          <div className="space-y-2">
            <FieldLabelWithHint htmlFor="facecam-roundness" hint={t("camera.roundness.hint")}>
              {t("camera.roundness")}
            </FieldLabelWithHint>
            <Slider
              id="facecam-roundness"
              min={0}
              max={FACE_CAM_COMPOSITION.maxRoundness}
              step={1}
              disabled={!hasFaceCam}
              value={[faceCam.roundness]}
              onValueChange={([v]) =>
                set("roundness", clamp(v ?? 0, 0, FACE_CAM_COMPOSITION.maxRoundness))
              }
            />
          </div>
        ) : null}

        {cameraUrl && (
          <ScreenContentCropPanel
            key="face-cam-crop"
            videoUrl={cameraUrl}
            hasBackground
            value={faceCam.crop}
            onChange={(crop) => set("crop", crop)}
            seekTo={cropPreviewTime}
            label={t("camera.crop")}
            hint={t("camera.crop.hint")}
          />
        )}
      </section>
    </div>
  );
}
