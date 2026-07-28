/**
 * The "Look" inspector panel — background selection + composition sliders.
 * Mirrors the web editor's `EditorLookPanel` design (tabs, preset grids, effect
 * sliders) using the ported design tokens.
 */

import { useState, type ChangeEvent } from "react";
import { Plus } from "lucide-react";

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";

import { useEditorStore } from "../store";
import { cn } from "../lib/cn";
import {
  BACKGROUND_TYPE_TABS,
  clampGradientAngle,
  gradientToCss,
  type BackgroundPreset,
  type BackgroundType,
} from "../lib/backgroundPresets";
import { maxDevicePaddingFor } from "../lib/composition";
import { useStageDimensions } from "../lib/useStageDimensions";
import { FieldLabel, SectionLabel } from "./ui";
import { ScreenContentCropPanel } from "./ScreenContentCropPanel";

const selectedRing = "border-primary ring-2 ring-primary/40";
const idleRing = "border-border hover:border-foreground/30";

const BG_TAB_LABEL_KEY: Record<BackgroundType, TranslationKey> = {
  image: "bg.image",
  gradient: "bg.gradient",
  color: "bg.color",
};

export function LookPanel({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const setBackgroundType = useEditorStore((s) => s.setBackgroundType);
  const selectedBackground = useEditorStore((s) => s.selectedBackground);
  const screenUrl = useEditorStore((s) => s.screenUrl);
  const sourceAspect = useEditorStore((s) => s.sourceAspect);
  const screenContentCrop = useEditorStore((s) => s.screenContentCrop);
  const setScreenContentCrop = useEditorStore((s) => s.setScreenContentCrop);
  // Freeze preview frame while playing — continuous seeks thrash media:// decode.
  // Selector returns a stable `undefined` during play so clock ticks do not
  // re-render this panel.
  const cropPreviewTime = useEditorStore((s) =>
    s.isPlaying ? undefined : s.currentTime,
  );

  return (
    <div className={cn("flex flex-col gap-7", !visible && "hidden")}>
      <div className="space-y-2">
        <SectionLabel>{t("look.background")}</SectionLabel>

        <div className="inline-flex items-center rounded-xl bg-muted p-1">
          {BACKGROUND_TYPE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBackgroundType(tab.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                backgroundType === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(BG_TAB_LABEL_KEY[tab.id])}
            </button>
          ))}
        </div>

        {backgroundType === "image" && <ImageGrid />}
        {backgroundType === "gradient" && <GradientGrid />}
        {backgroundType === "color" && <ColorGrid />}
      </div>

      {selectedBackground && screenUrl && (
        <ScreenContentCropPanel
          key="screen-content-crop"
          videoUrl={screenUrl}
          fileAspect={sourceAspect}
          hasBackground
          value={screenContentCrop}
          onChange={setScreenContentCrop}
          seekTo={cropPreviewTime}
        />
      )}

      {selectedBackground && <LookSliders />}
      {selectedBackground && <BackgroundEffects />}
    </div>
  );
}

function ImageGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.imagePresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const customImage = useEditorStore((s) => s.customImageBackground);
  const uploadCustomBackground = useEditorStore(
    (s) => s.uploadCustomBackground,
  );

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadCustomBackground(file);
    e.target.value = ""; // let the same file be re-picked
  };

  const swatch = (preset: BackgroundPreset) => (
    <button
      key={preset.id}
      type="button"
      title={preset.label}
      onClick={() => select(preset)}
      className={cn(
        "relative aspect-4/3 w-full overflow-hidden rounded-lg border text-left transition-colors",
        selected === preset.src ? selectedRing : idleRing,
      )}
    >
      {/* Inner layer: bg must not share the bordered box — avoids 1px edge blur in WKWebView. */}
      <span
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: preset.previewCss }}
        aria-hidden
      />
    </button>
  );

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {presets.map(swatch)}
      {customImage && swatch(customImage)}

      <label
        title={t("look.uploadImage")}
        className={cn(
          "relative flex aspect-4/3 w-full cursor-pointer items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground",
          idleRing,
        )}
      >
        <input
          type="file"
          accept="image/*"
          onChange={onPickFile}
          className="sr-only"
        />
        <Plus className="size-5" strokeWidth={2} />
        <span className="sr-only">{t("look.uploadImage")}</span>
      </label>
    </div>
  );
}

function GradientGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.gradientPresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const angle = useEditorStore((s) => s.customGradientAngle);
  const start = useEditorStore((s) => s.customGradientStart);
  const end = useEditorStore((s) => s.customGradientEnd);
  const applyCustom = useEditorStore((s) => s.applyCustomGradient);
  const [showCustom, setShowCustom] = useState(false);

  const customCss = gradientToCss({
    id: "c",
    label: "c",
    angle,
    stops: [
      { offset: 0, color: start },
      { offset: 100, color: end },
    ],
  });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.label}
            onClick={() => select(preset)}
            className={cn(
              "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
              selected === preset.src ? selectedRing : idleRing,
            )}
          >
            <span
              className="absolute inset-0"
              style={{ backgroundImage: preset.previewCss }}
            />
          </button>
        ))}
        <button
          type="button"
          title={t("look.custom")}
          onClick={() => {
            setShowCustom((v) => !v);
            applyCustom(angle, start, end);
          }}
          className={cn(
            "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
            idleRing,
          )}
        >
          <span
            className="absolute inset-0"
            style={{ backgroundImage: customCss }}
          />
          <span className="absolute inset-0 grid place-items-center">
            <span className="rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
              {t("look.custom")}
            </span>
          </span>
        </button>
      </div>

      {showCustom && (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-card/40 p-3">
          <ColorField
            label={t("look.start")}
            value={start}
            onChange={(c) => applyCustom(angle, c, end)}
          />
          <ColorField
            label={t("look.end")}
            value={end}
            onChange={(c) => applyCustom(angle, start, c)}
          />
          <div className="space-y-1">
            <FieldLabel>{t("look.angle")}</FieldLabel>
            <input
              type="number"
              min={0}
              max={360}
              value={angle}
              onChange={(e) =>
                applyCustom(
                  clampGradientAngle(Number(e.target.value)),
                  start,
                  end,
                )
              }
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ColorGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.colorPresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const customColor = useEditorStore((s) => s.customBackgroundColor);
  const setCustomColor = useEditorStore((s) => s.setCustomColor);

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.label}
          onClick={() => select(preset)}
          className={cn(
            "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
            selected === preset.src ? selectedRing : idleRing,
          )}
        >
          <span
            className="absolute inset-0"
            style={{ backgroundColor: preset.previewCss }}
          />
        </button>
      ))}
      <label
        className={cn(
          "relative aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-lg border",
          idleRing,
        )}
        title={t("look.custom")}
      >
        <input
          type="color"
          value={customColor}
          onChange={(e) => setCustomColor(e.target.value)}
          className="sr-only"
        />
        <span
          className="absolute inset-0"
          style={{ backgroundColor: customColor }}
        />
        <span className="absolute inset-0 grid place-items-center">
          <span className="rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
            {t("look.custom")}
          </span>
        </span>
      </label>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="space-y-1">
      <FieldLabel>{label}</FieldLabel>
      <label className="relative block h-9 cursor-pointer overflow-hidden rounded-md border border-input">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
        />
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
      </label>
    </div>
  );
}

function LookSliders() {
  const { t } = useI18n();
  const look = useEditorStore((s) => s.look);
  const setLook = useEditorStore((s) => s.setLook);
  const stage = useStageDimensions();
  const maxPadding = maxDevicePaddingFor(stage.width, stage.height);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FieldLabelWithHint
          htmlFor="device-padding"
          hint={t("look.padding.hint")}
        >
          {t("look.padding")}
        </FieldLabelWithHint>
        <Slider
          id="device-padding"
          min={0}
          max={maxPadding}
          step={1}
          value={[Math.min(look.devicePadding, maxPadding)]}
          onValueChange={([v]) => setLook("devicePadding", v ?? 0)}
        />
      </div>
      <div className="space-y-2">
        <FieldLabelWithHint
          htmlFor="corner-radius"
          hint={t("look.radius.hint")}
        >
          {t("look.radius")}
        </FieldLabelWithHint>
        <Slider
          id="corner-radius"
          min={0}
          max={300}
          step={1}
          value={[look.cornerRadius]}
          onValueChange={([v]) => setLook("cornerRadius", v ?? 0)}
        />
      </div>
      <div className="space-y-2">
        <FieldLabelWithHint htmlFor="shadow" hint={t("look.shadow.hint")}>
          {t("look.shadow")}
        </FieldLabelWithHint>
        <Slider
          id="shadow"
          min={0}
          max={200}
          step={1}
          value={[look.recordingShadowIntensity]}
          onValueChange={([v]) => setLook("recordingShadowIntensity", v ?? 0)}
        />
      </div>
    </div>
  );
}

function BackgroundEffects() {
  const { t } = useI18n();
  const look = useEditorStore((s) => s.look);
  const setLook = useEditorStore((s) => s.setLook);

  return (
    <div className="space-y-4 border-t border-border/60 pt-4">
      <SectionLabel>{t("look.effects")}</SectionLabel>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="bg-blur" hint={t("look.blur.hint")}>
            {t("look.blur")}
          </FieldLabelWithHint>
          <Slider
            id="bg-blur"
            min={0}
            max={60}
            step={1}
            value={[look.backgroundBlur]}
            onValueChange={([v]) => setLook("backgroundBlur", v ?? 0)}
          />
        </div>
        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="bg-dark" hint={t("look.darkness.hint")}>
            {t("look.darkness")}
          </FieldLabelWithHint>
          <Slider
            id="bg-dark"
            min={0}
            max={100}
            step={1}
            value={[look.backgroundDarkness]}
            onValueChange={([v]) => setLook("backgroundDarkness", v ?? 0)}
          />
        </div>
      </div>
    </div>
  );
}
