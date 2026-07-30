/** Recorder popover — setup bar, countdown, or in-record HUD. */

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Pencil, X } from "lucide-react";
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
  const prewarmCapture = useRecorderStore((s) => s.prewarmCapture);
  const [counting, setCounting] = useState(false);
  // The capture pipeline takes ~330ms to come up, and `status` only flips to
  // "recording" at the end of it. Gating the HUD on that left the window showing
  // nothing between the badge hitting zero and the recorder going live. This
  // renders the HUD immediately instead, and the pipeline finishes behind it.
  const [starting, setStarting] = useState(false);
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

  const live =
    status === "recording" || status === "paused" || status === "finalizing";
  // What the window shows. `starting` covers the pipeline bring-up window so the
  // HUD is on screen the instant the countdown ends.
  const showHud = live || starting;

  // Hand off from the optimistic HUD to the real one: `live` means the recorder
  // came up, `lastError` means it did not (`startRecording` swallows failures
  // into that field). Pressing Record clears any stale error, so this cannot
  // trip on one left over from a previous attempt.
  useEffect(() => {
    if (starting && (live || lastError)) setStarting(false);
  }, [starting, live, lastError]);

  useEffect(() => {
    if (counting) void commands.setRecorderLayout("countdown");
    else if (showHud) void commands.setRecorderLayout("hud");
    else if (lastError) void commands.setRecorderLayout("alert");
    else void commands.setRecorderLayout("setup");
  }, [showHud, counting, lastError]);

  useEffect(() => {
    const inkLive = status === "recording" || status === "paused";
    if (!inkLive && wasLiveRef.current) {
      setAnnotationVisible(false);
    }
    wasLiveRef.current = inkLive;
  }, [status, setAnnotationVisible]);

  // Stable identity: `start` is a zustand action, so this is created once. The
  // countdown latches its own fire, but a stable prop means its ref-sync effect
  // never re-runs either.
  const onCountdownDone = useCallback(() => {
    // Swap straight to the HUD; do not wait for `start()` to resolve.
    setStarting(true);
    setCounting(false);
    void start();
  }, [start]);

  const onRecord = useCallback(() => {
    // Clear a stale error before counting, so the `starting` hand-off above
    // cannot mistake it for this attempt failing.
    useRecorderStore.setState({ lastError: null });
    setCounting(true);
    // Mic / face-cam come up during the countdown rather than after it.
    void prewarmCapture();
  }, [prewarmCapture]);

  return (
    <div className="bg-transparent font-sans text-foreground">
      {showHud ? (
        <RecordingHud starting={starting} />
      ) : counting ? (
        <Countdown onDone={onCountdownDone} />
      ) : (
        <RecorderToolbar onRecord={onRecord} />
      )}
      <ErrorToast />
    </div>
  );
}

/**
 * `starting` is the optimistic window: the HUD is on screen but the capture
 * pipeline is still coming up, so the controls are disabled the same way they are
 * during finalize. Without that, a Stop pressed inside those ~330ms would reach a
 * recorder that is not live yet and surface a `NotRecording` error.
 */
function RecordingHud({ starting }: { starting: boolean }) {
  const { t } = useI18n();
  const status = useRecorderStore((s) => s.state.status);
  const elapsed = useRecorderStore((s) => s.elapsed);
  const annotationVisible = useRecorderStore((s) => s.annotationVisible);
  const setAnnotationVisible = useRecorderStore((s) => s.setAnnotationVisible);
  const stop = useRecorderStore((s) => s.stopRecording);
  const togglePause = useRecorderStore((s) => s.togglePause);

  const finalizing = status === "finalizing";
  const paused = status === "paused";
  /** Controls are unusable while the pipeline is coming up or tearing down. */
  const busy = finalizing || starting;
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
        disabled={busy}
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
        <Pencil className="size-4" />
      </button>
      <button
        type="button"
        data-tauri-drag-region="false"
        disabled={busy}
        onClick={() => void togglePause()}
        className={cn(
          "h-9 rounded-xl border border-border bg-transparent px-3 text-xs font-medium text-foreground transition-colors",
          "hover:bg-muted disabled:opacity-40",
          paused &&
            "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
        )}
      >
        {paused ? t("recorder.hud.resume") : t("recorder.hud.pause")}
      </button>
      <Button
        type="button"
        size="sm"
        data-tauri-drag-region="false"
        disabled={busy}
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
