/**
 * Editor root — icon rail + Appearance/Zoom inspector above the preview, with a
 * full-width timeline docked across the bottom. Capptivo logo swaps this shell
 * to the in-window recordings library (no second window).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { totalKeptDuration } from "@/engine";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/settings";
import { commands } from "@/ipc/bindings";
import { useEditorStore } from "./store";
import { CaptionsPanel } from "./components/CaptionsPanel";
import { CameraPanel } from "./components/CameraPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { CursorPanel } from "./components/CursorPanel";
import { ExportProgressOverlay } from "./components/ExportProgressOverlay";
import { ExportSettingsDialog } from "./components/ExportSettingsDialog";
import { EditorTitleBar } from "./components/EditorTitleBar";
import { InspectorChrome } from "./components/InspectorChrome";
import { LookPanel } from "./components/LookPanel";
import { PreviewStage } from "./components/PreviewStage";
import { RecordingsLibrary } from "./components/RecordingsLibrary";
import { Timeline } from "./components/Timeline";
import { ZoomPanel } from "./components/ZoomPanel";
import type { ExportSettings } from "./export/exportSettings";
import { exportProject } from "./export/exportVideo";
import { useStageDimensions } from "./lib/useStageDimensions";
import { presentableVideoTime } from "./lib/presentableVideoTime";

const SHOW_LIBRARY_EVENT = "shell://show-library";

function initialShell(): "editor" | "library" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "library") return "library";
  return "editor";
}

export function EditorApp() {
  const { t } = useI18n();
  const init = useEditorStore((s) => s.init);
  const ready = useEditorStore((s) => s.ready);
  const error = useEditorStore((s) => s.error);
  const inspectorPanel = useEditorStore((s) => s.inspectorPanel);
  const setInspectorPanel = useEditorStore((s) => s.setInspectorPanel);
  const cameraUrl = useEditorStore((s) => s.cameraUrl);
  const recordingMetadata = useEditorStore((s) => s.recordingMetadata);
  const zoomFragments = useEditorStore((s) => s.zoomFragments);
  const selectedZoomFragmentId = useEditorStore((s) => s.selectedZoomFragmentId);
  const selectZoomFragment = useEditorStore((s) => s.selectZoomFragment);
  const updateSelectedZoomFragment = useEditorStore((s) => s.updateSelectedZoomFragment);
  const duration = useEditorStore((s) => s.duration);
  const segments = useEditorStore((s) => s.segments);
  const exporting = useEditorStore((s) => s.exporting);
  const exportError = useEditorStore((s) => s.exportError);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const stage = useStageDimensions();
  const [exportOpen, setExportOpen] = useState(false);
  const [shell, setShell] = useState<"editor" | "library">(initialShell);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "library") {
      useEditorStore.setState({ ready: true, error: null });
      // Rust already showed this window on the active display — don't re-present
      // (that used to yank to the primary monitor and flash Spaces).
      return;
    }
    const id = params.get("project");
    if (id) void init(id);
    else useEditorStore.setState({ ready: true, error: "No project id in URL." });
  }, [init]);

  useEffect(() => {
    let alive = true;
    const unlisten = listen(SHOW_LIBRARY_EVENT, () => {
      if (alive) setShell("library");
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Closing the editor destroys the webview — a debounced save still in its
  // 400ms window, or an IPC write still in flight, would die with it. Flush on
  // hide/pagehide (best-effort), and on native close *await* the save chain
  // before destroy so the last edit lands.
  //
  // `onCloseRequested` intercepts the close; we `preventDefault`, persist, then
  // `destroy()`. Needs `core:window:allow-destroy` (capabilities/default.json).
  useEffect(() => {
    const flush = () => useEditorStore.getState().flushEditorPersist();
    const onPageHide = () => {
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    let closing = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    void win
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          await flush();
        } finally {
          await win.destroy().catch(() => undefined);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisten = listen<string>("project://finalized", (e) => {
      if (!alive) return;
      const id = e.payload;
      if (!id) return;
      // Editor often opens on the stub before camera.webm is registered — reload.
      const current = useEditorStore.getState().projectId;
      const urlId = new URLSearchParams(window.location.search).get("project");
      if (id === current || id === urlId) void init(id);
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, [init]);

  useEffect(() => {
    if (shell !== "library") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useEditorStore.getState().projectId) {
        setShell("editor");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);

  const openRecordings = useCallback(() => {
    useEditorStore.getState().setPlaying(false);
    setShell("library");
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      await init(id);
      history.replaceState(null, "", `?project=${encodeURIComponent(id)}`);
      setShell("editor");
    },
    [init],
  );

  const kept = segments.length > 0 ? totalKeptDuration(segments) : duration;

  const renameTitle = useCallback(
    (next: string) => {
      const { projectId: pid, project: p } = useEditorStore.getState();
      if (!pid || !p) return;
      const title = next.trim() || null;
      const prev = p.title?.trim() || null;
      if (title === prev) return;
      void commands
        .renameProject(pid, title)
        .then(() => {
          useEditorStore.setState({ project: { ...p, title } });
        })
        .catch(() => undefined);
    },
    [],
  );

  const runExport = (settings: ExportSettings) => {
    setExportOpen(false);
    void exportProject(settings);
  };

  /** Seek the shared <video> and store together (playhead + track clicks). */
  const seek = (time: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = presentableVideoTime(time, video.duration);
    useEditorStore.getState().setCurrentTime(time);
  };

  if (shell === "library") {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
          <EditorTitleBar title={t("recorder.recordings")} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RecordingsLibrary currentProjectId={projectId} onOpenProject={(id) => void openProject(id)} />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  const windowTitle = project?.title?.trim() || t("app.untitled");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <EditorTitleBar
          title={windowTitle}
          renameSeed={project?.title?.trim() ?? ""}
          onRename={renameTitle}
          exportError={exportError}
          exporting={exporting}
          exportDisabled={kept <= 0}
          showExport
          showPresets
          onExport={() => setExportOpen(true)}
        />
        {/* Top row: inspector rail + preview share the height above the timeline. */}
        <div className="flex min-h-0 flex-1">
          <InspectorChrome
            activePanel={inspectorPanel}
            onPanelChange={setInspectorPanel}
            hasFaceCam={!!cameraUrl}
            onOpenRecordings={openRecordings}
          >
            <LookPanel visible={inspectorPanel === "look"} />
            <CursorPanel visible={inspectorPanel === "cursor"} />
            <CameraPanel visible={inspectorPanel === "camera"} />
            <ZoomPanel
              visible={inspectorPanel === "zoom"}
              recordingMetadata={recordingMetadata}
              zoomFragments={zoomFragments}
              selectedZoomFragmentId={selectedZoomFragmentId}
              onSelectZoomFragmentId={selectZoomFragment}
              updateSelectedZoomFragment={updateSelectedZoomFragment}
            />
            <CaptionsPanel visible={inspectorPanel === "captions"} />
            <ConfigPanel visible={inspectorPanel === "config"} />
          </InspectorChrome>

          <div className="flex min-w-0 flex-1 flex-col">
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {error ? (
                <p className="p-6 text-sm text-destructive">{error}</p>
              ) : !ready ? (
                <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>
              ) : (
                <PreviewStage videoRef={videoRef} />
              )}
            </main>
          </div>
        </div>

        {/* Full-width timeline docked across the bottom of the app. */}
        {ready && !error && (
          <div className="shrink-0">
            <Timeline onSeek={seek} videoRef={videoRef} />
          </div>
        )}

        <ExportSettingsDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          stageWidth={stage.width}
          stageHeight={stage.height}
          exporting={exporting}
          onConfirm={runExport}
        />
        <ExportProgressOverlay />
      </div>
    </TooltipProvider>
  );
}
