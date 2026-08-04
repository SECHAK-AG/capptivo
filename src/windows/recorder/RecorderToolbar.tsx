/** Floating recorder setup bar (source, devices, camera/mic, settings). */

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  GripVertical,
  Monitor,
  MonitorSpeaker,
  Mic,
  MicOff,
  Pencil,
  Settings,
  Smartphone,
  SquareDashed,
  VolumeX,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { LANGUAGES } from "@/lib/i18n";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { commands } from "../../ipc/bindings";
import type { CaptureSource } from "../../ipc/types";
import { RecorderMenu } from "./RecorderMenu";
import { useBarDrag } from "./menuSurface";
import type { BarOffset } from "./barOffset";
import { useRecorderStore, type CaptureMode } from "./store";
import { usePlatformCapabilities } from "./usePlatformCapabilities";

const CTRL = "h-9";

/** Only one popover is open at a time — they share the bar's window space. */
type MenuId =
  | "display"
  | "window"
  | "device"
  | "camera"
  | "mic"
  | "audio"
  | "settings";

export function RecorderToolbar({
  onRecord,
  onDragPreview,
  onDragCommit,
}: {
  onRecord: () => void;
  /** Direct DOM transform during drag — no React re-render per frame. */
  onDragPreview: (offset: BarOffset) => void;
  /** Hitbox resync after the store commit on pointer-up. */
  onDragCommit: () => void;
}) {
  const { t } = useI18n();
  const caps = usePlatformCapabilities();
  const captureMode = useRecorderStore((s) => s.captureMode);
  const areaSelection = useRecorderStore((s) => s.areaSelection);
  const selectedSourceId = useRecorderStore((s) => s.selectedSourceId);
  // Quartz's legacy still-image APIs can block WindowServer on current macOS.
  // Keep native thumbnails on Windows; source metadata is enough elsewhere.
  const includePickerThumbnails = caps?.os === "windows";
  const selectedDeviceId = useRecorderStore((s) => s.selectedDeviceId);

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  // Clicking a second trigger opens it *and* dismisses the first, in whichever
  // order the events land — a close only counts for the menu that owns it.
  const setMenuOpen = (id: MenuId, open: boolean) =>
    setOpenMenu((current) => (open ? id : current === id ? null : current));

  const canRecord =
    captureMode === "area"
      ? !!areaSelection
      : captureMode === "device"
        ? !!selectedDeviceId
        : !!selectedSourceId;

  const annotationVisible = useRecorderStore((s) => s.annotationVisible);
  const setAnnotationVisible = useRecorderStore((s) => s.setAnnotationVisible);
  const annotateLabel = annotationVisible
    ? t("recorder.hud.annotate.hide")
    : t("recorder.hud.annotate.show");

  const areaSize = areaSelection
    ? `${Math.round(areaSelection.crop.width)}×${Math.round(areaSelection.crop.height)}`
    : null;
  const areaLabel = areaSize ?? t("recorder.mode.area");
  const areaTitle = areaSize
    ? t("recorder.mode.areaSelected", { size: areaSize })
    : t("recorder.mode.areaTitle");

  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const offsetRef = useRef(useBarDrag.getState().offset);
  const setBarOffset = useBarDrag((s) => s.setOffset);
  const dragRafRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  const dragStartRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    initialLeft: number;
    initialTop: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    return useBarDrag.subscribe((s) => {
      offsetRef.current = s.offset;
    });
  }, []);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const sync = () => {
      const width =
        Math.ceil(Math.max(el.scrollWidth, el.getBoundingClientRect().width)) + 2;
      void commands.setRecorderBarWidth(width);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, []);

  const onGripPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setOpenMenu(null);
    if (draggingRef.current || !barRef.current) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    void commands.beginRecorderDrag();

    const rect = barRef.current.getBoundingClientRect();
    const origin = offsetRef.current;
    dragStartRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: origin.x,
      originY: origin.y,
      initialLeft: rect.left,
      initialTop: rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const onGripPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    pendingPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (dragRafRef.current !== null) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const drag = dragStartRef.current;
      const pointer = pendingPointerRef.current;
      if (!drag || !pointer) return;
      const dx = pointer.clientX - drag.startX;
      const dy = pointer.clientY - drag.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(
        Math.max(0, drag.initialLeft + dx),
        Math.max(0, vw - drag.width),
      );
      const top = Math.min(
        Math.max(0, drag.initialTop + dy),
        Math.max(0, vh - drag.height),
      );
      const next = {
        x: drag.originX + (left - drag.initialLeft),
        y: drag.originY + (top - drag.initialTop),
      };
      offsetRef.current = next;
      onDragPreview(next);
    });
  };

  const endGripDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Guard re-entry: releasePointerCapture synthesizes lostpointercapture.
    if (!draggingRef.current) return;
    const start = dragStartRef.current;
    if (start && start.pointerId !== e.pointerId) return;
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingPointerRef.current = null;
    dragStartRef.current = null;
    // One store write for the whole gesture — React re-applies the same transform.
    setBarOffset(offsetRef.current);
    onDragCommit();
    void commands.endRecorderDrag();
  };

  return (
    <div className="relative w-fit">
      <div
        ref={barRef}
        className="flex items-center gap-1 rounded-2xl border border-border bg-card p-1.5"
      >
        <div
          className={cn(
            CTRL,
            "flex w-7 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing",
          )}
          title={t("recorder.drag")}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={endGripDrag}
          onPointerCancel={endGripDrag}
          onLostPointerCapture={endGripDrag}
        >
          <GripVertical className="pointer-events-none size-4" />
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(CTRL, "size-9 shrink-0")}
          aria-label={t("recorder.recordings")}
          title={t("recorder.recordings")}
          onClick={() => void commands.openLibrary()}
        >
          <img src="/logo.svg" alt="" className="size-5 object-contain" />
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(CTRL, "size-9 shrink-0 text-muted-foreground")}
          aria-label={t("recorder.close")}
          onClick={() => void commands.hideRecorder()}
        >
          <X className="size-4" />
        </Button>

        <Divider />

        <div className="flex items-center gap-0.5">
          <CaptureModeMenu
            mode="display"
            label={t("recorder.mode.display")}
            icon={<Monitor className="size-3.5" />}
            active={captureMode === "display"}
            open={openMenu === "display"}
            onOpenChange={(open) => {
              if (open) {
                useRecorderStore.getState().setCaptureMode("display");
                void useRecorderStore.getState().refreshSources({
                  thumbnails: includePickerThumbnails,
                });
              }
              setMenuOpen("display", open);
            }}
          />
          {caps?.canEnumerateSources !== false ? (
            <CaptureModeMenu
              mode="window"
              label={t("recorder.mode.window")}
              icon={<AppWindowIcon />}
              active={captureMode === "window"}
              open={openMenu === "window"}
              onOpenChange={(open) => {
                if (open) {
                  useRecorderStore.getState().setCaptureMode("window");
                  void useRecorderStore.getState().refreshSources({
                    thumbnails: includePickerThumbnails,
                  });
                }
                setMenuOpen("window", open);
              }}
            />
          ) : null}
          {caps?.canPickArea !== false ? (
            <ModeBtn
              active={captureMode === "area"}
              label={areaLabel}
              icon={<SquareDashed className="size-3.5" />}
              title={areaTitle}
              onClick={() => void useRecorderStore.getState().pickArea()}
            />
          ) : null}
          {caps?.canCaptureDevice ? (
            <DeviceMenu
              open={openMenu === "device"}
              onOpenChange={(open) => {
                if (open) useRecorderStore.getState().setCaptureMode("device");
                setMenuOpen("device", open);
              }}
            />
          ) : null}
        </div>

        <Divider />

        <div className="flex shrink-0 items-center gap-0.5">
          <CameraMenu
            open={openMenu === "camera"}
            onOpenChange={(open) => setMenuOpen("camera", open)}
          />
          <MicMenu
            open={openMenu === "mic"}
            onOpenChange={(open) => setMenuOpen("mic", open)}
          />
          <AudioMenu
            open={openMenu === "audio"}
            onOpenChange={(open) => setMenuOpen("audio", open)}
          />
        </div>

        <Divider />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            CTRL,
            "size-9 shrink-0 text-muted-foreground",
            annotationVisible && "bg-primary/20 text-primary hover:bg-primary/25",
          )}
          aria-label={annotateLabel}
          aria-pressed={annotationVisible}
          title={annotateLabel}
          onClick={() => setAnnotationVisible(!annotationVisible)}
        >
          <Pencil className="size-4" />
        </Button>

        <SettingsMenu
          open={openMenu === "settings"}
          onOpenChange={(open) => setMenuOpen("settings", open)}
        />

        <Button
          type="button"
          size="sm"
          disabled={!canRecord}
          onClick={onRecord}
          className="h-9 shrink-0 gap-2 rounded-xl px-3.5 font-semibold"
        >
          <span className="size-2 rounded-full bg-primary-foreground" />
          {t("recorder.record")}
        </Button>
      </div>
    </div>
  );
}

function CaptureModeMenu({
  mode,
  label,
  icon,
  active,
  open,
  onOpenChange,
}: {
  mode: CaptureMode;
  label: string;
  icon: ReactNode;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      className="w-[min(28rem,calc(100vw-1.5rem))]"
      trigger={<ModeBtn active={active} label={label} icon={icon} />}
    >
      <SourceMenuContent mode={mode} onPick={() => onOpenChange(false)} />
    </RecorderMenu>
  );
}

const DEVICE_POLL_MS = 2000;

/** USB iPhone/iPad picker — polls while open because devices plug in/out. */
function DeviceMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const captureMode = useRecorderStore((s) => s.captureMode);
  const devices = useRecorderStore((s) => s.devices);
  const selectedDeviceId = useRecorderStore((s) => s.selectedDeviceId);
  const refreshDevices = useRecorderStore((s) => s.refreshDevices);
  const loading = useRecorderStore((s) => s.loadingDevices);
  const deviceError = useRecorderStore((s) => s.deviceError);
  const selectDevice = useRecorderStore((s) => s.selectDevice);

  useEffect(() => {
    if (!open) return;
    void refreshDevices();
    const timer = setInterval(() => void refreshDevices(), DEVICE_POLL_MS);
    return () => clearInterval(timer);
  }, [open, refreshDevices]);

  const selected = devices.find((d) => d.id === selectedDeviceId);
  const label = selected
    ? shortenLabel(selected.name, 12)
    : t("recorder.mode.device");

  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      className="w-72"
      trigger={
        <ModeBtn
          active={captureMode === "device"}
          label={label}
          icon={<Smartphone className="size-3.5" />}
          title={
            selected
              ? t("recorder.mode.deviceRecording", { name: selected.name })
              : t("recorder.mode.deviceTitle")
          }
        />
      }
    >
      <div className="mb-1.5 flex items-center justify-between px-2 pt-0.5">
        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {t("recorder.devices")}
        </p>
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void refreshDevices()}
        >
          {loading ? "…" : t("recorder.refresh")}
        </button>
      </div>

      <div className="max-h-52 space-y-0.5 overflow-y-auto">
        {devices.map((device) => (
          <button
            key={device.id}
            type="button"
            onClick={() => {
              selectDevice(device.id);
              onOpenChange(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              device.id === selectedDeviceId
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Smartphone className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{device.name}</span>
            {device.width > 0 ? (
              <span className="shrink-0 text-[10px] tabular-nums opacity-60">
                {device.width}×{device.height}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {devices.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">
          {deviceError ?? t("recorder.devices.empty")}
        </p>
      ) : null}
    </RecorderMenu>
  );
}

function CameraMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const cameras = useRecorderStore((s) => s.cameras);
  const cameraEnabled = useRecorderStore((s) => s.cameraEnabled);
  const cameraDeviceId = useRecorderStore((s) => s.cameraDeviceId);
  const setCameraEnabled = useRecorderStore((s) => s.setCameraEnabled);
  const setCameraDeviceId = useRecorderStore((s) => s.setCameraDeviceId);
  const ensureCameraDevices = useRecorderStore((s) => s.ensureCameraDevices);
  const requestCameraAccess = useRecorderStore((s) => s.requestCameraAccess);
  const [devicesReady, setDevicesReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setDevicesReady(false);
      return;
    }
    let cancelled = false;
    void ensureCameraDevices().finally(() => {
      if (!cancelled) setDevicesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, ensureCameraDevices]);

  const value = !cameraEnabled ? "off" : (cameraDeviceId ?? "off");

  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      className="w-56"
      trigger={
        <DeviceTrigger
          active={cameraEnabled}
          icon={
            cameraEnabled ? (
              <Camera className="size-3.5" />
            ) : (
              <CameraOff className="size-3.5" />
            )
          }
          label={cameraEnabled ? t("recorder.camera") : t("recorder.camera.off")}
        />
      }
    >
      <SelectMenuItem
        selected={value === "off"}
        onSelect={() => setCameraEnabled(false)}
      >
        {t("recorder.camera.off")}
      </SelectMenuItem>
      {cameras.map((cam) => (
        <SelectMenuItem
          key={cam.deviceId}
          selected={value === cam.deviceId}
          onSelect={() => setCameraDeviceId(cam.deviceId)}
        >
          {cam.label}
        </SelectMenuItem>
      ))}
      {!devicesReady && cameras.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">{t("app.loading")}</p>
      ) : null}
      {devicesReady && cameras.length === 0 ? (
        <button
          type="button"
          className="w-full px-2 py-2 text-left text-xs text-primary hover:underline"
          onClick={() => void requestCameraAccess()}
        >
          {t("recorder.camera.grant")}
        </button>
      ) : null}
    </RecorderMenu>
  );
}

function MicMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const microphones = useRecorderStore((s) => s.microphones);
  const micEnabled = useRecorderStore((s) => s.micEnabled);
  const micDeviceId = useRecorderStore((s) => s.micDeviceId);
  const setMicEnabled = useRecorderStore((s) => s.setMicEnabled);
  const setMicDeviceId = useRecorderStore((s) => s.setMicDeviceId);
  const ensureMicrophoneDevices = useRecorderStore(
    (s) => s.ensureMicrophoneDevices,
  );
  const [devicesReady, setDevicesReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setDevicesReady(false);
      return;
    }
    let cancelled = false;
    void ensureMicrophoneDevices().finally(() => {
      if (!cancelled) setDevicesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, ensureMicrophoneDevices]);

  const selectedMic = microphones.find((m) => m.deviceId === micDeviceId);
  const triggerLabel = micEnabled
    ? shortenLabel(selectedMic?.label ?? t("recorder.mic"), 16)
    : t("recorder.mic.off");

  const value = !micEnabled ? "off" : (micDeviceId ?? "off");

  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      className="w-56"
      trigger={
        <DeviceTrigger
          active={micEnabled}
          icon={
            micEnabled ? (
              <Mic className="size-3.5" />
            ) : (
              <MicOff className="size-3.5" />
            )
          }
          label={triggerLabel}
        />
      }
    >
      <SelectMenuItem
        selected={value === "off"}
        onSelect={() => setMicEnabled(false)}
      >
        {t("recorder.mic.off")}
      </SelectMenuItem>
      {microphones.map((mic) => (
        <SelectMenuItem
          key={mic.deviceId}
          selected={value === mic.deviceId}
          onSelect={() => setMicDeviceId(mic.deviceId)}
        >
          {mic.label}
        </SelectMenuItem>
      ))}
      {!devicesReady && microphones.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">{t("app.loading")}</p>
      ) : null}
      {devicesReady && microphones.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {t("recorder.mic.off")}
        </p>
      ) : null}
    </RecorderMenu>
  );
}

function AudioMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const enabled = useRecorderStore((s) => s.options.captureSystemAudio);
  const setOption = useRecorderStore((s) => s.setOption);

  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      className="w-52"
      trigger={
        <DeviceTrigger
          active={enabled}
          icon={
            enabled ? (
              <MonitorSpeaker className="size-3.5" />
            ) : (
              <VolumeX className="size-3.5" />
            )
          }
          label={enabled ? t("recorder.audio") : t("recorder.audio.off")}
        />
      }
    >
      <SelectMenuItem
        selected={!enabled}
        onSelect={() => setOption("captureSystemAudio", false)}
      >
        {t("recorder.audio.none")}
      </SelectMenuItem>
      <SelectMenuItem
        selected={enabled}
        onSelect={() => setOption("captureSystemAudio", true)}
      >
        {t("recorder.audio.system")}
      </SelectMenuItem>
    </RecorderMenu>
  );
}

function SettingsMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, language, setLanguage } = useI18n();

  return (
    <RecorderMenu
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      className="w-44"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            CTRL,
            "size-9 shrink-0 text-muted-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
          )}
          aria-label={t("recorder.settings.open")}
          title={t("recorder.settings.open")}
        >
          <Settings className="size-4" />
        </Button>
      }
    >
      <DropdownMenuItem
        className="rounded-md"
        onSelect={() => {
          void commands.checkForUpdates();
        }}
      >
        {t("recorder.settings.checkUpdates")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <p className="mb-1 px-2 pt-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {t("recorder.language")}
      </p>
      {LANGUAGES.map(({ id, label }) => (
        <SelectMenuItem
          key={id}
          selected={language === id}
          onSelect={() => setLanguage(id)}
        >
          {label}
        </SelectMenuItem>
      ))}
    </RecorderMenu>
  );
}

function SelectMenuItem({
  selected,
  children,
  onSelect,
}: {
  selected: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem className="gap-2 rounded-md" onSelect={onSelect}>
      <Check
        className={cn(
          "size-4 shrink-0 text-foreground",
          selected ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate">{children}</span>
    </DropdownMenuItem>
  );
}

function SourceMenuContent({
  mode,
  onPick,
}: {
  mode: CaptureMode;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const sources = useRecorderStore((s) => s.sources);
  const selectedId = useRecorderStore((s) => s.selectedSourceId);
  const select = useRecorderStore((s) => s.selectSource);
  const loading = useRecorderStore((s) => s.loadingSources);
  const refresh = useRecorderStore((s) => s.refreshSources);
  const caps = usePlatformCapabilities();
  const filtered = sources.filter((s) => s.kind === mode);

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between px-2 pt-0.5">
        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {mode === "display"
            ? t("recorder.sources.displays")
            : t("recorder.sources.windows")}
        </p>
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void refresh({ thumbnails: caps?.os === "windows" })}
        >
          {loading ? "…" : t("recorder.refresh")}
        </button>
      </div>

      {mode === "display" ? (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {filtered.map((source, i) => {
            const selected = source.id === selectedId;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => {
                  select(source.id);
                  onPick();
                }}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors",
                  selected
                    ? "border-primary/50 bg-primary/10"
                    : "border-transparent hover:bg-accent/80",
                )}
              >
                <SourceThumbnail
                  source={source}
                  index={i}
                  className="aspect-video w-full rounded-md"
                />
                <span className="truncate px-0.5 pb-0.5 text-center text-xs text-muted-foreground">
                  {source.title || `${t("recorder.mode.display")} ${i + 1}`}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {filtered.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => {
                select(source.id);
                onPick();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                source.id === selectedId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <SourceThumbnail
                source={source}
                className="h-9 w-14 shrink-0 rounded-md"
              />
              <span className="min-w-0 truncate">{source.title}</span>
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">
          {t("recorder.sources.empty")}
        </p>
      ) : null}
    </>
  );
}

function SourceThumbnail({
  source,
  index,
  className,
}: {
  source: CaptureSource;
  index?: number;
  className?: string;
}) {
  if (source.thumbnail) {
    return (
      <img
        src={`data:image/png;base64,${source.thumbnail}`}
        alt=""
        className={cn("object-cover", className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "grid place-items-center bg-muted text-xs font-semibold tabular-nums text-muted-foreground",
        className,
      )}
    >
      {source.kind === "display" ? (index ?? 0) + 1 : <AppWindowIcon />}
    </span>
  );
}

const ModeBtn = forwardRef<
  HTMLButtonElement,
  {
    active: boolean;
    label: string;
    icon: ReactNode;
    disabled?: boolean;
    title?: string;
  } & ComponentPropsWithoutRef<"button">
>(({ active, label, icon, disabled, title, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    title={title ?? label}
    disabled={disabled}
    className={cn(
      CTRL,
      "flex w-[3.6rem] flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium transition-colors",
      "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
      "data-[state=open]:bg-muted data-[state=open]:text-foreground",
      active && "bg-muted text-foreground",
      disabled && "pointer-events-none opacity-35",
      className,
    )}
    {...props}
  >
    {icon}
    <span className="leading-none">{label}</span>
  </button>
));
ModeBtn.displayName = "ModeBtn";

const DeviceTrigger = forwardRef<
  HTMLButtonElement,
  {
    active: boolean;
    icon: ReactNode;
    label: string;
  } & ComponentPropsWithoutRef<"button">
>(({ active, icon, label, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    title={label}
    className={cn(
      CTRL,
      "flex shrink-0 items-center gap-1.5 rounded-xl px-2 text-xs transition-colors",
      "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
      "data-[state=open]:bg-muted data-[state=open]:text-foreground",
      active && "text-foreground",
      className,
    )}
    {...props}
  >
    <span className="shrink-0">{icon}</span>
    <span className="whitespace-nowrap text-left">{label}</span>
    <ChevronDown className="size-3 shrink-0 opacity-50" />
  </button>
));
DeviceTrigger.displayName = "DeviceTrigger";

function shortenLabel(label: string, max: number): string {
  const t = label.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

function Divider() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

function AppWindowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 8h18" />
    </svg>
  );
}
