/** Recorder popover — setup bar, countdown, or in-record HUD. */

import { useEffect, useRef, useState } from "react";
import { GripVertical, Highlighter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { commands } from "../../ipc/bindings";
import { useRecorderStore } from "./store";
import { Countdown } from "./Countdown";
import { RecorderToolbar } from "./RecorderToolbar";

export function RecorderApp() {
  const init = useRecorderStore((s) => s.init);
  const status = useRecorderStore((s) => s.state.status);
  const lastError = useRecorderStore((s) => s.lastError);
  const setAnnotationVisible = useRecorderStore((s) => s.setAnnotationVisible);
  const start = useRecorderStore((s) => s.startRecording);
  const [counting, setCounting] = useState(false);
  const wasLiveRef = useRef(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const projectId = import.meta.env.VITE_GATE_PROJECT_ID;
    const loopbackBase = import.meta.env.VITE_GATE_LOOPBACK;
    if (!projectId || !loopbackBase) return;
    void (async () => {
      const { runMediaOriginGate } = await import("../editor/mediaOriginProbe");
      const { mediaUrl } = await import("@/lib/platform");
      await runMediaOriginGate(
        (file) => mediaUrl(projectId, file),
        loopbackBase,
        projectId,
      );
    })();
  }, []);

  const live = status === "recording" || status === "paused" || status === "finalizing";

  useEffect(() => {
    if (counting) void commands.setRecorderLayout("countdown");
    else if (live) void commands.setRecorderLayout("hud");
    else if (lastError) void commands.setRecorderLayout("alert");
    else void commands.setRecorderLayout("setup");
  }, [live, counting, lastError]);

  useEffect(() => {
    const inkLive = status === "recording" || status === "paused";
    if (!inkLive && wasLiveRef.current) {
      setAnnotationVisible(false);
    }
    wasLiveRef.current = inkLive;
  }, [status, setAnnotationVisible]);

  return (
    <div className="bg-transparent font-sans text-foreground">
      {live ? (
        <RecordingHud />
      ) : counting ? (
        <Countdown
          onDone={() => {
            void (async () => {
              await start();
              setCounting(false);
            })();
          }}
        />
      ) : (
        <RecorderToolbar onRecord={() => setCounting(true)} />
      )}
      <ErrorToast />
    </div>
  );
}

function RecordingHud() {
  const { t } = useI18n();
  const status = useRecorderStore((s) => s.state.status);
  const elapsed = useRecorderStore((s) => s.elapsed);
  const annotationVisible = useRecorderStore((s) => s.annotationVisible);
  const setAnnotationVisible = useRecorderStore((s) => s.setAnnotationVisible);
  const stop = useRecorderStore((s) => s.stopRecording);
  const togglePause = useRecorderStore((s) => s.togglePause);

  const finalizing = status === "finalizing";
  const paused = status === "paused";
  const annotateLabel = annotationVisible
    ? t("recorder.hud.annotate.hide")
    : t("recorder.hud.annotate.show");

  return (
    <div className="inline-flex h-12 w-fit max-w-full items-center gap-1.5 rounded-2xl border border-border bg-card p-1.5">
      <div
        data-tauri-drag-region
        className="flex h-9 cursor-grab items-center gap-2 rounded-xl px-1.5 active:cursor-grabbing"
        title={t("recorder.drag")}
      >
        <GripVertical className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            paused ? "bg-muted-foreground" : "animate-pulse bg-primary",
          )}
        />
        <span className="min-w-13 text-sm font-semibold tabular-nums text-foreground">
          {formatElapsed(elapsed)}
        </span>
        {finalizing ? (
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            {t("recorder.hud.finalizing")}
          </span>
        ) : paused ? (
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            {t("recorder.hud.paused")}
          </span>
        ) : null}
      </div>
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      <button
        type="button"
        data-tauri-drag-region="false"
        disabled={finalizing}
        title={annotateLabel}
        aria-label={annotateLabel}
        aria-pressed={annotationVisible}
        onClick={() => setAnnotationVisible(!annotationVisible)}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl border transition-colors disabled:opacity-40",
          annotationVisible
            ? "border-primary/40 bg-primary/20 text-primary hover:bg-primary/25"
            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Highlighter className="size-4" />
      </button>
      <button
        type="button"
        data-tauri-drag-region="false"
        disabled={finalizing}
        onClick={() => void togglePause()}
        className={cn(
          "h-9 rounded-xl border border-border bg-transparent px-3 text-xs font-medium text-foreground transition-colors",
          "hover:bg-muted disabled:opacity-40",
          paused && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
        )}
      >
        {paused ? t("recorder.hud.resume") : t("recorder.hud.pause")}
      </button>
      <Button
        type="button"
        size="sm"
        data-tauri-drag-region="false"
        disabled={finalizing}
        onClick={() => void stop()}
        className="h-9 gap-1.5 rounded-xl px-3 font-semibold"
      >
        <span className="size-2 rounded-[2px] bg-primary-foreground" />
        {t("recorder.hud.stop")}
      </Button>
    </div>
  );
}

function ErrorToast() {
  const { t } = useI18n();
  const error = useRecorderStore((s) => s.lastError);
  const clear = () => useRecorderStore.setState({ lastError: null });

  useEffect(() => {
    if (!error?.trim()) return;
    const id = window.setTimeout(clear, 6000);
    return () => window.clearTimeout(id);
  }, [error]);

  if (!error?.trim()) return null;
  return (
    <div className="mt-2 flex max-w-md items-start gap-2 rounded-lg bg-destructive/20 px-3 py-2 text-xs text-foreground ring-1 ring-destructive/40">
      <p className="min-w-0 flex-1 leading-snug">{error}</p>
      <button
        type="button"
        aria-label={t("recorder.error.dismiss")}
        onClick={clear}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
