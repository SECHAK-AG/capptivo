import { useEffect, useState } from "react";

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  CURSOR_CLICK_EFFECT_IDS,
  CURSOR_PREVIEW_FRAME_PX,
  CURSOR_STYLE_IDS,
  cursorPreviewGlyphPx,
  cursorStylePreviewUrl,
  ensureCursorAsset,
  loadCursorAsset,
  preloadCursorAssets,
  type CursorClickEffectId,
  type CursorStyleId,
} from "@/engine";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useEditorStore } from "../store";
import { SectionLabel } from "./ui";

const STYLE_LABEL_KEYS: Record<CursorStyleId, TranslationKey> = {
  macos: "cursor.style.macos",
  tahoe: "cursor.style.tahoe",
  "tahoe-inverted": "cursor.style.tahoe-inverted",
  figma: "cursor.style.figma",
};

const CLICK_EFFECT_LABEL_KEYS: Record<CursorClickEffectId, TranslationKey> = {
  none: "cursor.clickEffect.none",
  ripple: "cursor.clickEffect.ripple",
  spotlight: "cursor.clickEffect.spotlight",
  echo: "cursor.clickEffect.echo",
};

function StylePreview({ style }: { style: CursorStyleId }) {
  const [src, setSrc] = useState(() => cursorStylePreviewUrl(style));
  const glyphPx = cursorPreviewGlyphPx(style);

  useEffect(() => {
    let cancelled = false;
    setSrc(cursorStylePreviewUrl(style));
    void loadCursorAsset(style).then((asset) => {
      if (!cancelled && asset) setSrc(asset.previewUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [style]);

  return (
    <div
      className="flex items-center justify-center"
      style={{ width: CURSOR_PREVIEW_FRAME_PX, height: CURSOR_PREVIEW_FRAME_PX }}
      aria-hidden
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="max-w-none object-contain"
          style={{ width: glyphPx, height: glyphPx }}
        />
      ) : null}
    </div>
  );
}

type SliderRowProps = {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
};

function SliderRow({ id, label, hint, value, min, max, step, format, onChange }: SliderRowProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <FieldLabelWithHint htmlFor={id} hint={hint}>
            {label}
          </FieldLabelWithHint>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v ?? value)}
      />
    </div>
  );
}

export function CursorPanel({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  const cursorSettings = useEditorStore((s) => s.cursorSettings);
  const recordingMetadata = useEditorStore((s) => s.recordingMetadata);
  const setCursorSettings = useEditorStore((s) => s.setCursorSettings);

  const hasTrack = (recordingMetadata?.cursorSamples.length ?? 0) > 0;

  useEffect(() => {
    preloadCursorAssets();
    for (const id of CURSOR_STYLE_IDS) ensureCursorAsset(id);
  }, []);

  useEffect(() => {
    ensureCursorAsset(cursorSettings.style);
  }, [cursorSettings.style]);

  return (
    <div className={cn("flex flex-col gap-6", !visible && "hidden")}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <FieldLabelWithHint htmlFor="cursor-show" hint={t("cursor.show.hint")}>
            {t("cursor.show")}
          </FieldLabelWithHint>
          <Switch
            id="cursor-show"
            checked={cursorSettings.showCursor}
            disabled={!hasTrack}
            onCheckedChange={(showCursor) => setCursorSettings({ showCursor })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <FieldLabelWithHint htmlFor="cursor-auto-hide" hint={t("cursor.autoHide.hint")}>
            {t("cursor.autoHide")}
          </FieldLabelWithHint>
          <Switch
            id="cursor-auto-hide"
            checked={cursorSettings.hideStaticCursor}
            disabled={!hasTrack || !cursorSettings.showCursor}
            onCheckedChange={(hideStaticCursor) => setCursorSettings({ hideStaticCursor })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <FieldLabelWithHint htmlFor="cursor-loop" hint={t("cursor.loop.hint")}>
            {t("cursor.loop")}
          </FieldLabelWithHint>
          <Switch
            id="cursor-loop"
            checked={cursorSettings.loopCursor}
            disabled={!hasTrack || !cursorSettings.showCursor}
            onCheckedChange={(loopCursor) => setCursorSettings({ loopCursor })}
          />
        </div>
      </div>

      {!hasTrack ? (
        <p className="text-xs text-muted-foreground">{t("cursor.noTrack")}</p>
      ) : null}

      <section className="space-y-2">
        <SectionLabel>{t("cursor.style.title")}</SectionLabel>
        <div className="grid grid-cols-4 gap-2">
          {CURSOR_STYLE_IDS.map((id) => {
            const selected = cursorSettings.style === id;
            return (
              <button
                key={id}
                type="button"
                title={t(STYLE_LABEL_KEYS[id])}
                aria-label={t(STYLE_LABEL_KEYS[id])}
                aria-pressed={selected}
                disabled={!hasTrack}
                onClick={() => setCursorSettings({ style: id })}
                className={cn(
                  "flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-[10px] border p-2 transition-colors disabled:opacity-40",
                  selected
                    ? "border-primary bg-muted/30 ring-1 ring-primary/40"
                    : "border-border bg-muted/30 hover:border-foreground/25",
                )}
              >
                <StylePreview style={id} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <SliderRow
          id="cursor-size"
          label={t("cursor.size")}
          hint={t("cursor.size.hint")}
          min={0.5}
          max={4}
          step={0.05}
          value={cursorSettings.size}
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(size) => setCursorSettings({ size })}
        />
        <SliderRow
          id="cursor-motion-blur"
          label={t("cursor.motionBlur")}
          hint={t("cursor.motionBlur.hint")}
          min={0}
          max={1}
          step={0.05}
          value={cursorSettings.motionBlur}
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(motionBlur) => setCursorSettings({ motionBlur })}
        />
        <SliderRow
          id="cursor-smoothness"
          label={t("cursor.smoothness")}
          hint={t("cursor.smoothness.hint")}
          min={0}
          max={1}
          step={0.05}
          value={cursorSettings.smoothness}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(smoothness) => setCursorSettings({ smoothness })}
        />
        <SliderRow
          id="cursor-click-shrink"
          label={t("cursor.clickShrink")}
          hint={t("cursor.clickShrink.hint")}
          min={0}
          max={0.4}
          step={0.01}
          value={cursorSettings.clickShrink}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(clickShrink) => setCursorSettings({ clickShrink })}
        />
        <SliderRow
          id="cursor-sway"
          label={t("cursor.sway")}
          hint={t("cursor.sway.hint")}
          min={0}
          max={1}
          step={0.05}
          value={cursorSettings.sway}
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(sway) => setCursorSettings({ sway })}
        />
      </section>

      <section className="space-y-2">
        <SectionLabel>{t("cursor.clickEffect")}</SectionLabel>
        <Select
          value={cursorSettings.clickEffect}
          onValueChange={(v) =>
            setCursorSettings({ clickEffect: v as CursorClickEffectId })
          }
          disabled={!hasTrack || !cursorSettings.showCursor}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURSOR_CLICK_EFFECT_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(CLICK_EFFECT_LABEL_KEYS[id])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
    </div>
  );
}
