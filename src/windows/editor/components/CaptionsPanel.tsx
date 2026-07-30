/**
 * Captions inspector — local Whisper + web-matching style controls.
 */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { commands } from "@/ipc/bindings";
import { captionsHaveWordTimings } from "@/captions/captionTiming";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/settings";
import { useEditorStore } from "../store";
import { cn } from "../lib/cn";
import { SectionLabel } from "./ui";
import { CaptionStyleControls } from "./CaptionStyleControls";
import { CaptionEditSheet } from "./CaptionEditSheet";

/** Speech languages for Whisper — curated list, not tied to UI locale. Default stays `auto`. */
const WHISPER_LANGUAGES: { value: string; labelKey: TranslationKey }[] = [
  { value: "auto", labelKey: "captions.lang.auto" },
  { value: "en", labelKey: "captions.lang.en" },
  { value: "fr", labelKey: "captions.lang.fr" },
  { value: "es", labelKey: "captions.lang.es" },
  { value: "it", labelKey: "captions.lang.it" },
  { value: "de", labelKey: "captions.lang.de" },
  { value: "pt", labelKey: "captions.lang.pt" },
  { value: "ru", labelKey: "captions.lang.ru" },
  { value: "ja", labelKey: "captions.lang.ja" },
  { value: "ko", labelKey: "captions.lang.ko" },
  { value: "zh", labelKey: "captions.lang.zh" },
  { value: "ar", labelKey: "captions.lang.ar" },
];

export function CaptionsPanel({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const captionSettings = useEditorStore((s) => s.captionSettings);
  const captions = useEditorStore((s) => s.captions);
  const captionGenerating = useEditorStore((s) => s.captionGenerating);
  const captionError = useEditorStore((s) => s.captionError);
  const setCaptionSettings = useEditorStore((s) => s.setCaptionSettings);
  const generateCaptions = useEditorStore((s) => s.generateCaptions);
  const clearCaptions = useEditorStore((s) => s.clearCaptions);
  const updateCaptionTexts = useEditorStore((s) => s.updateCaptionTexts);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const setPlaying = useEditorStore((s) => s.setPlaying);

  const [modelReady, setModelReady] = useState(false);
  const [downloadPct, setDownloadPct] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [genPhase, setGenPhase] = useState<string | null>(null);

  const refreshModel = useCallback(async () => {
    try {
      const st = await commands.getWhisperModelStatus();
      setModelReady(st.exists);
    } catch {
      setModelReady(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refreshModel();
  }, [visible, refreshModel]);

  useEffect(() => {
    const un = listen<{
      status: string;
      progress: number;
      path?: string | null;
    }>("captions://model-download", (e) => {
      const { status, progress } = e.payload;
      if (status === "downloading") {
        setDownloading(true);
        setDownloadPct(progress);
      } else if (status === "downloaded") {
        setDownloading(false);
        setDownloadPct(100);
        setModelReady(true);
      } else if (status === "idle" || status === "error") {
        setDownloading(false);
        if (status === "idle") {
          setModelReady(false);
        }
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const un = listen<{ phase?: string }>("captions://progress", (e) => {
      setGenPhase(e.payload.phase ?? null);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  const cueCount = captions.length;
  const wordTimingsAvailable = captionsHaveWordTimings(captions);

  return (
    <div className={cn("flex flex-col gap-4", !visible && "hidden")}>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("captions.desc")}
      </p>

      <section className="space-y-2">
        <SectionLabel>{t("captions.language")}</SectionLabel>
        <Select
          value={captionSettings.language}
          onValueChange={(v) => setCaptionSettings({ language: v })}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WHISPER_LANGUAGES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {t(l.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section className="space-y-2">
        <FieldLabelWithHint className="text-xs" hint={t("captions.model.hint")}>
          {t("captions.model")}
        </FieldLabelWithHint>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={downloading || modelReady}
            onClick={() => void commands.downloadWhisperModel().then(() => refreshModel())}
          >
            {downloading
              ? t("captions.model.downloading", { percent: downloadPct })
              : modelReady
                ? t("captions.model.ready")
                : t("captions.model.download")}
          </Button>
          {modelReady ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => void commands.deleteWhisperModel().then(() => refreshModel())}
            >
              {t("captions.model.remove")}
            </Button>
          ) : null}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            className="min-w-0 flex-1"
            disabled={!modelReady || captionGenerating}
            onClick={() => void generateCaptions()}
          >
            {captionGenerating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {genPhase === "transcribing"
                  ? t("captions.transcribing")
                  : t("captions.preparing")}
              </>
            ) : cueCount > 0 ? (
              t("captions.regenerate")
            ) : (
              t("captions.generate")
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={cueCount === 0 || captionGenerating}
            onClick={() => clearCaptions()}
          >
            {t("captions.clear")}
          </Button>
        </div>
        {captionError ? (
          <p className="text-xs text-amber-600 dark:text-amber-400" role="alert">
            {captionError}
          </p>
        ) : null}
      </section>

      <CaptionEditSheet
        captions={captions}
        onSubmit={updateCaptionTexts}
        onSeek={(timeSec) => {
          setPlaying(false);
          setCurrentTime(timeSec);
        }}
      />

      <CaptionStyleControls
        hasCaptions={cueCount > 0}
        wordTimingsAvailable={wordTimingsAvailable}
        captionSettings={captionSettings}
        onChange={(patch) => setCaptionSettings(patch)}
      />
    </div>
  );
}
