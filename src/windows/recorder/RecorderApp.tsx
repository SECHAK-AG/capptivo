/** Recorder popover — setup bar, countdown, or in-record HUD. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  GripVertical,
  Maximize2,
  Mic,
  MicOff,
  Minus,
  Pause,
  Pencil,
  Play,
  Square,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "../../ipc/bindings";
import { RecorderBarAnchor } from "./RecorderErrorToast";
import { useRecorderStore } from "./store";
import { Countdown } from "./Countdown";
import { useBarDrag } from "./menuSurface";
import { barTransform, type BarOffset } from "./barOffset";
import { RecorderToolbar } from "./RecorderToolbar";

/** Keep in sync with `duration-300` on `BarPane`. */
const BAR_CROSSFADE_MS = 300;
/** Matches `RECORDER_BOTTOM_MARGIN` in `windows.rs`. */
const BAR_BOTTOM_MARGIN_PX = 20;

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
  /** Skip setup→HUD crossfade when arriving from the countdown badge. */
  const fromCountdownRef = useRef(false);

  // Crossfade: keep the outgoing pane mounted until the CSS transition ends.
  const [hudOn, setHudOn] = useState(false);
  const [mountSetup, setMountSetup] = useState(true);
  const [mountHud, setMountHud] = useState(false);
  /** Fade-in only when HUD appears after countdown (no setup pane to crossfade). */
  const [hudEnter, setHudEnter] = useState(false);
  const barOffset = useBarDrag((s) => s.offset);
  const resetBarOffset = useBarDrag((s) => s.resetOffset);
  const chromeRef = useRef<HTMLDivElement>(null);
  const syncHitboxRef = useRef<(() => void) | null>(null);
  const areaSelection = useRecorderStore((s) => s.areaSelection);
  const captureMode = useRecorderStore((s) => s.captureMode);

  // Live drag preview — mutate the chrome node directly (no React re-render).
  const onDragPreview = useCallback((offset: BarOffset) => {
    const el = chromeRef.current;
    if (el) el.style.transform = barTransform(offset);
  }, []);

  // After store commit on pointer-up, resync click-through hitbox once layout settles.
  const onDragCommit = useCallback(() => {
    requestAnimationFrame(() => syncHitboxRef.current?.());
  }, []);

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

  // Esc dismisses the crop guide (click-through window can't take keys itself).
  useEffect(() => {
    if (captureMode !== "area" || !areaSelection || counting || showHud) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void commands.hideAreaFrameGuide().catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureMode, areaSelection, counting, showHud]);

  // Hand off from the optimistic HUD to the real one: `live` means the recorder
  // came up, `lastError` means it did not (`startRecording` swallows failures
  // into that field). Pressing Record clears any stale error, so this cannot
  // trip on one left over from a previous attempt.
  useEffect(() => {
    if (starting && (live || lastError)) setStarting(false);
  }, [starting, live, lastError]);

  // Bar mount + native layout in one place so resize timing matches the fade.
  useEffect(() => {
    if (counting) {
      setHudOn(false);
      setMountSetup(true);
      setMountHud(false);
      void commands.setRecorderLayout("countdown");
      return;
    }

    if (showHud) {
      const snap = fromCountdownRef.current;
      fromCountdownRef.current = false;
      setMountHud(true);
      setHudOn(true);
      setHudEnter(snap);
      if (snap) {
        // Native frame already docked in `onCountdownDone` before we left the
        // countdown tree — do not re-race layout here (Windows showed a centered
        // 240×240 window with a horizontal scrollbar when HUD painted first).
        setMountSetup(false);
        resetBarOffset();
        return;
      }
      // Keep setup overlay until the outgoing pane finishes fading.
      const id = window.setTimeout(() => {
        setMountSetup(false);
        resetBarOffset();
        void commands.setRecorderLayout("hud");
      }, BAR_CROSSFADE_MS);
      return () => window.clearTimeout(id);
    }

    setMountSetup(true);
    setHudOn(false);
    setHudEnter(false);
    if (lastError) void commands.setRecorderLayout("alert");
    else void commands.setRecorderLayout("setup");
    const id = window.setTimeout(() => setMountHud(false), BAR_CROSSFADE_MS);
    return () => window.clearTimeout(id);
  }, [showHud, counting, lastError, resetBarOffset]);

  useEffect(() => {
    const inkLive = status === "recording" || status === "paused";
    if (!inkLive && wasLiveRef.current) {
      setAnnotationVisible(false);
    }
    wasLiveRef.current = inkLive;
  }, [status, setAnnotationVisible]);

  // Report chrome hitbox so the work-area overlay click-throughs everywhere else.
  useEffect(() => {
    const el = chromeRef.current;
    if (!el || counting || showHud) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      void commands.setRecorderBarHitbox(r.left, r.top, r.width, r.height);
    };
    syncHitboxRef.current = sync;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    // ResizeObserver fires an initial callback, but keep an explicit sync so the
    // first paint cannot leave the bar click-through before that lands.
    sync();
    return () => {
      if (syncHitboxRef.current === sync) syncHitboxRef.current = null;
      ro.disconnect();
    };
    // Position changes resync via onDragCommit — barOffset must stay out of deps.
  }, [counting, showHud, mountSetup, mountHud, lastError]);

  // Stable identity: `start` is a zustand action, so this is created once. The
  // countdown latches its own fire, but a stable prop means its ref-sync effect
  // never re-runs either.
  const onCountdownDone = useCallback(() => {
    fromCountdownRef.current = true;
    // Dock the compact HUD frame *before* leaving the countdown tree. Painting
    // the wide HUD inside the 240×240 centered badge first overflows on
    // WebView2 (horizontal scrollbar flash in the middle of the screen).
    void (async () => {
      try {
        await commands.setRecorderLayout("hud");
      } catch (e) {
        console.error("[recorder] hud layout before mount failed", e);
      }
      setStarting(true);
      setCounting(false);
      void start();
    })();
  }, [start]);

  const onRecord = useCallback(() => {
    // Clear a stale error before counting, so the `starting` hand-off above
    // cannot mistake it for this attempt failing.
    useRecorderStore.setState({ lastError: null, elapsed: 0 });
    setCounting(true);
    // Mic / face-cam come up during the countdown rather than after it.
    void prewarmCapture();
  }, [prewarmCapture]);

  if (counting) {
    return (
      <div className="relative h-full overflow-hidden bg-transparent font-sans text-foreground">
        <div className="grid h-full place-items-center">
          <Countdown onDone={onCountdownDone} />
        </div>
        <div
          className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 justify-center"
          style={{ bottom: BAR_BOTTOM_MARGIN_PX }}
        >
          <RecorderBarAnchor>
            <div className="h-9 w-px" aria-hidden />
          </RecorderBarAnchor>
        </div>
      </div>
    );
  }

  // HUD uses a compact native window — center the chrome.
  if (showHud && !mountSetup) {
    return (
      <div className="pointer-events-none flex h-full w-full items-center justify-center overflow-visible bg-transparent font-sans text-foreground">
        <div className="pointer-events-auto">
          {mountHud ? (
            <RecorderBarAnchor>
              <BarPane active={hudOn} enter={hudEnter}>
                <RecordingHud starting={starting} />
              </BarPane>
            </RecorderBarAnchor>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-none relative h-full w-full bg-transparent font-sans text-foreground",
        lastError ? "overflow-visible" : "overflow-hidden",
      )}
    >
      <div
        ref={chromeRef}
        className="pointer-events-auto absolute left-1/2 flex w-fit flex-col items-center"
        style={{
          bottom: BAR_BOTTOM_MARGIN_PX,
          transform: barTransform(barOffset),
        }}
      >
        <RecorderBarAnchor>
          {mountSetup ? (
            <BarPane active={!hudOn}>
              <RecorderToolbar
                onRecord={onRecord}
                onDragPreview={onDragPreview}
                onDragCommit={onDragCommit}
              />
            </BarPane>
          ) : null}
          {mountHud ? (
            <BarPane active={hudOn} enter={hudEnter}>
              <RecordingHud starting={starting} />
            </BarPane>
          ) : null}
        </RecorderBarAnchor>
      </div>
    </div>
  );
}

/**
 * Stacked setup/HUD panes: the active one is in normal flow (sizes the window
 * content); the outgoing one is absolutely centered so both stay put while
 * opacity/scale crossfade. `enter` adds a short fade-in when the HUD mounts
 * after countdown (no outgoing setup pane).
 */
function BarPane({
  active,
  enter = false,
  children,
}: {
  active: boolean;
  enter?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "origin-center transition-[opacity,transform] duration-300 ease-out",
        active
          ? cn(
              "relative z-10 opacity-100 scale-100",
              enter && "animate-in fade-in zoom-in-95 duration-300",
            )
          : "pointer-events-none absolute bottom-0 left-1/2 z-0 -translate-x-1/2 opacity-0 scale-[0.97]",
      )}
      aria-hidden={!active}
    >
      {children}
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
  const micEnabled = useRecorderStore((s) => s.micEnabled);
  const micDeviceId = useRecorderStore((s) => s.micDeviceId);
  const micSessionMuted = useRecorderStore((s) => s.micSessionMuted);
  const annotationVisible = useRecorderStore((s) => s.annotationVisible);
  const setAnnotationVisible = useRecorderStore((s) => s.setAnnotationVisible);
  const toggleMicMute = useRecorderStore((s) => s.toggleMicMute);
  const stop = useRecorderStore((s) => s.stopRecording);
  const togglePause = useRecorderStore((s) => s.togglePause);
  const [collapsed, setCollapsed] = useState(false);

  const finalizing = status === "finalizing";
  const paused = status === "paused";
  /** Controls are unusable while the pipeline is coming up or tearing down. */
  const busy = finalizing || starting;
  const micArmed = micEnabled && !!micDeviceId;
  const annotateLabel = annotationVisible
    ? t("recorder.hud.annotate.hide")
    : t("recorder.hud.annotate.show");
  const micLabel = !micArmed
    ? t("recorder.hud.mic.unavailable")
    : micSessionMuted
      ? t("recorder.hud.mic.unmute")
      : t("recorder.hud.mic.mute");

  useEffect(() => {
    void commands.setRecorderLayout(collapsed ? "hud-mini" : "hud");
  }, [collapsed]);

  if (collapsed) {
    return (
      <div className="inline-flex h-10 w-fit items-center gap-0.5 rounded-2xl border border-border bg-card p-1">
        <div
          className="flex h-8 cursor-grab items-center gap-1.5 rounded-xl pl-1 pr-2.5 active:cursor-grabbing"
          title={t("recorder.drag")}
          onPointerDown={startHudWindowDrag}
        >
          <span className="flex w-6 shrink-0 items-center justify-center text-muted-foreground">
            <GripVertical className="pointer-events-none size-4" />
          </span>
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              paused ? "bg-muted-foreground" : "animate-pulse bg-primary",
            )}
          />
          <span
            className={cn(
              "text-[11px] font-semibold tracking-wider",
              paused ? "text-muted-foreground" : "text-primary",
            )}
          >
            {paused ? t("recorder.hud.paused") : "REC"}
          </span>
          <span className="min-w-11 text-sm font-semibold tabular-nums text-foreground">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <HudIconBtn
          className="size-8"
          title={t("recorder.hud.expand")}
          aria-label={t("recorder.hud.expand")}
          onClick={() => setCollapsed(false)}
        >
          <Maximize2 className="size-3.5" />
        </HudIconBtn>
      </div>
    );
  }

  return (
    <div className="inline-flex h-12 w-fit max-w-full items-center gap-0.5 rounded-2xl border border-border bg-card p-1.5">
      <div
        className="flex h-9 cursor-grab items-center gap-1.5 rounded-xl pl-0.5 pr-2 active:cursor-grabbing"
        title={t("recorder.drag")}
        onPointerDown={startHudWindowDrag}
      >
        <span className="flex w-7 shrink-0 items-center justify-center text-muted-foreground">
          <GripVertical className="pointer-events-none size-4" />
        </span>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-muted-foreground" : "animate-pulse bg-primary",
          )}
        />
        <span
          className={cn(
            "text-[11px] font-semibold tracking-wider",
            paused ? "text-muted-foreground" : "text-primary",
          )}
        >
          {finalizing
            ? t("recorder.hud.finalizing")
            : paused
              ? t("recorder.hud.paused")
              : "REC"}
        </span>
        <span className="min-w-11 text-sm font-semibold tabular-nums text-foreground">
          {formatElapsed(elapsed)}
        </span>
      </div>

      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />

      {micArmed ? (
        <HudIconBtn
          disabled={busy}
          title={micLabel}
          aria-label={micLabel}
          aria-pressed={micSessionMuted}
          onClick={() => toggleMicMute()}
          className={micSessionMuted ? "text-muted-foreground" : undefined}
        >
          {micSessionMuted ? (
            <MicOff className="size-4" />
          ) : (
            <Mic className="size-4" />
          )}
        </HudIconBtn>
      ) : (
        <HudIconBtn
          disabled
          title={micLabel}
          aria-label={micLabel}
          className="text-muted-foreground/50"
        >
          <MicOff className="size-4" />
        </HudIconBtn>
      )}

      <HudIconBtn
        disabled={busy}
        title={paused ? t("recorder.hud.resume") : t("recorder.hud.pause")}
        aria-label={paused ? t("recorder.hud.resume") : t("recorder.hud.pause")}
        onClick={() => void togglePause()}
        className={paused ? "text-primary" : undefined}
      >
        {paused ? (
          <Play className="size-4 fill-current" />
        ) : (
          <Pause className="size-4" />
        )}
      </HudIconBtn>

      <HudIconBtn
        disabled={busy}
        title={t("recorder.hud.stop")}
        aria-label={t("recorder.hud.stop")}
        onClick={() => void stop()}
        className="text-primary hover:bg-primary/15 hover:text-primary"
      >
        <Square className="size-3.5 fill-current" />
      </HudIconBtn>

      <HudIconBtn
        disabled={busy}
        title={annotateLabel}
        aria-label={annotateLabel}
        aria-pressed={annotationVisible}
        onClick={() => setAnnotationVisible(!annotationVisible)}
        className={
          annotationVisible
            ? "bg-primary/15 text-primary hover:bg-primary/20"
            : undefined
        }
      >
        <Pencil className="size-4" />
      </HudIconBtn>

      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />

      <HudIconBtn
        disabled={busy}
        title={t("recorder.hud.collapse")}
        aria-label={t("recorder.hud.collapse")}
        onClick={() => setCollapsed(true)}
      >
        <Minus className="size-4" />
      </HudIconBtn>

      <HudIconBtn
        disabled={busy}
        title={t("recorder.hud.hide")}
        aria-label={t("recorder.hud.hide")}
        onClick={() => void commands.hideRecorder()}
      >
        <X className="size-4" />
      </HudIconBtn>
    </div>
  );
}

const HUD_ICON =
  "flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** Compact HUD uses a docked native window — startDragging moves the HWND. */
function startHudWindowDrag(e: ReactPointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  void getCurrentWindow().startDragging();
}

function HudIconBtn({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      className={cn(HUD_ICON, className)}
      {...props}
    >
      {children}
    </button>
  );
}

function formatElapsed(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
