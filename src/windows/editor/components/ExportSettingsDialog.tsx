import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Clapperboard, Download, ImageIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";

import {
  exceedsSourceFps,
  exportDimensionsFor,
  formatGifSpeed,
  gifFpsForPreset,
  GIF_SPEED_MAX,
  GIF_SPEED_MIN,
  GIF_SPEED_STEP,
  clampGifSpeed,
  type ExportAudioEnhance,
  type ExportContainer,
  type ExportEncoding,
  type ExportFps,
  type ExportSettings,
} from "../export/exportSettings";
import {
  loadLastExportSettings,
  saveLastExportSettings,
} from "../lib/editorPresets";
import { SectionLabel } from "./ui";

const ENCODING_LABEL_KEY: Record<ExportEncoding, TranslationKey> = {
  fast: "encoding.fast",
  balanced: "encoding.balanced",
  quality: "encoding.quality",
};

type ExportSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Composition stage — output size follows the timeline's ratio picker. */
  stageWidth: number;
  stageHeight: number;
  /** Rate the take was captured at, or null for projects that never recorded it. */
  sourceFps: number | null;
  exporting: boolean;
  onConfirm: (settings: ExportSettings) => void;
};

const ENCODINGS: ExportEncoding[] = ["fast", "balanced", "quality"];
const FPS_OPTIONS: ExportFps[] = [24, 30, 60];
const CONTAINERS: ExportContainer[] = ["mp4", "webm"];
const AUDIO_ENHANCE_OPTIONS: { id: ExportAudioEnhance; labelKey: TranslationKey }[] = [
  { id: "off", labelKey: "export.enhanceVoice.off" },
  { id: "podcast", labelKey: "export.enhanceVoice.on" },
];

const selectedRing = "border-primary ring-2 ring-primary/40";
const idleRing = "border-border hover:border-foreground/30";

export function ExportSettingsDialog({
  open,
  onOpenChange,
  stageWidth,
  stageHeight,
  sourceFps,
  exporting,
  onConfirm,
}: ExportSettingsDialogProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ExportSettings>(() => loadLastExportSettings());

  useEffect(() => {
    if (open) setSettings(loadLastExportSettings());
  }, [open]);

  // Output size is fixed by the timeline's ratio picker; only the format cap varies.
  const dims = useMemo(
    () => exportDimensionsFor(stageWidth, stageHeight, settings.format),
    [stageWidth, stageHeight, settings.format],
  );

  const patch = <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => {
    setSettings((s) => {
      const next = { ...s, [key]: value };
      saveLastExportSettings(next);
      return next;
    });
  };

  const isGif = settings.format === "gif";
  // GIF rates are mapped down from the preset (see gifFpsForPreset), so they
  // can never outrun the source.
  const aboveSource = !isGif && exceedsSourceFps(settings.fps, sourceFps);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 border-border bg-card p-5 sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {t("export.dialog.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("export.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <SectionLabel>{t("export.format")}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <FormatCard
              selected={settings.format === "mp4"}
              icon={<Clapperboard className="size-5" />}
              label="MP4"
              onClick={() => patch("format", "mp4")}
            />
            <FormatCard
              selected={isGif}
              icon={<ImageIcon className="size-5" />}
              label="GIF"
              onClick={() => patch("format", "gif")}
            />
          </div>
          {/* Size follows the timeline's aspect-ratio picker — no separate setting. */}
          <p className="text-xs text-muted-foreground">
            {t("export.size")}{" "}
            <span className="tabular-nums text-foreground">
              {dims.width} × {dims.height}
            </span>
          </p>
        </div>

        <Field label={isGif ? t("export.gifQuality") : t("export.encoding")}>
          <PillGroup
            value={settings.encoding}
            onChange={(v) => patch("encoding", v)}
            options={ENCODINGS.map((id) => ({ id, label: t(ENCODING_LABEL_KEY[id]) }))}
          />
        </Field>

        <Field label={t("export.fps")}>
          <PillGroup
            value={String(settings.fps)}
            onChange={(v) => patch("fps", Number(v) as ExportFps)}
            options={FPS_OPTIONS.map((fps) => ({
              id: String(fps),
              label: String(isGif ? gifFpsForPreset(fps) : fps),
            }))}
          />
          {/* Say what a rate above the capture rate actually buys, rather than
              clamping it away — overlay motion really does get smoother. */}
          {aboveSource ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("export.fps.aboveSource", { fps: sourceFps ?? 0 })}
            </p>
          ) : null}
        </Field>

        {!isGif ? (
          <>
            <Field label={t("export.type")}>
              <PillGroup
                value={settings.container}
                onChange={(v) => patch("container", v)}
                options={CONTAINERS.map((id) => ({ id, label: id }))}
              />
            </Field>
            <Field label={t("export.enhanceVoice")}>
              <PillGroup
                value={settings.audioEnhance}
                onChange={(v) => patch("audioEnhance", v)}
                options={AUDIO_ENHANCE_OPTIONS.map((o) => ({
                  id: o.id,
                  label: t(o.labelKey),
                }))}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("export.enhanceVoice.hint")}
              </p>
            </Field>
          </>
        ) : (
          <Field label={t("export.gifSpeed")}>
            <div className="flex items-center gap-3">
              <Slider
                id="export-gif-speed"
                min={GIF_SPEED_MIN}
                max={GIF_SPEED_MAX}
                step={GIF_SPEED_STEP}
                value={[clampGifSpeed(settings.gifSpeed)]}
                onValueChange={([v]) =>
                  patch("gifSpeed", clampGifSpeed(v ?? settings.gifSpeed))
                }
                className="flex-1"
              />
              <span className="w-10 shrink-0 text-right text-sm tabular-nums text-foreground">
                {formatGifSpeed(settings.gifSpeed)}
              </span>
            </div>
          </Field>
        )}

        <Button
          size="lg"
          className="w-full"
          disabled={exporting}
          onClick={() => onConfirm(settings)}
        >
          <Download className="size-4" />
          {exporting ? t("export.exporting") : t("export.confirm")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function FormatCard({
  selected,
  icon,
  label,
  onClick,
}: {
  selected: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-lg border bg-muted/40 text-sm font-medium transition-colors",
        selected ? cn(selectedRing, "text-foreground") : cn(idleRing, "text-muted-foreground"),
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

/** Same pill pattern as Appearance background-type tabs. */
function PillGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div role="radiogroup" className="inline-flex w-full items-center rounded-xl bg-muted p-1">
      {options.map((opt) => {
        const selected = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.id)}
            className={cn(
              "min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
