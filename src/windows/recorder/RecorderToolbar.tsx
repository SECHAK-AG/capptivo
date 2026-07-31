/** Floating recorder setup bar (source, devices, camera/mic, settings). */

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGES } from "@/lib/i18n";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { commands } from "../../ipc/bindings";
import type { CaptureSource } from "../../ipc/types";
import { useRecorderStore, type CaptureMode } from "./store";
import { usePlatformCapabilities } from "./usePlatformCapabilities";

const CTRL = "h-9";

const MENU_CONTENT =
  "rounded-xl border-border/80 bg-popover p-1.5 shadow-lg ring-1 ring-border/40";

/** Tauri clips the WebView to the native window — grow when menus open. */
function applyRecorderLayout(sourceOpen: boolean, auxOpen: boolean) {
  if (sourceOpen) return commands.setRecorderLayout("menu");
  if (auxOpen) return commands.setRecorderLayout("dropdown");
  if (useRecorderStore.getState().lastError) {
    return commands.setRecorderLayout("alert");
  }
  return commands.setRecorderLayout("setup");
}

export function RecorderToolbar({ onRecord }: { onRecord: () => void }) {
  const { t } = useI18n();
  const caps = usePlatformCapabilities();
  const captureMode = useRecorderStore((s) => s.captureMode);
  const areaSelection = useRecorderStore((s) => s.areaSelection);
  const selectedSourceId = useRecorderStore((s) => s.selectedSourceId);
  const selectedDeviceId = useRecorderStore((s) => s.selectedDeviceId);

  const [sourceOpen, setSourceOpen] = useState(false);
  const [auxMenu, setAuxMenu] = useState<
    "camera" | "mic" | "audio" | "settings" | null
  >(null);

  // Controlled `open` must flip in the same turn as Radix's pointerdown.
  // Awaiting layout first deferred mount until mid-gesture, so the same
  // pointerup landed on a menu item and looked like a flash-select.
  const setSourceMenuOpen = (open: boolean) => {
    if (open) {
      void applyRecorderLayout(true, auxMenu !== null);
      setSourceOpen(true);
      return;
    }
    setSourceOpen(false);
    void applyRecorderLayout(false, auxMenu !== null);
  };

  const setAuxMenuOpen = (id: typeof auxMenu) => {
    if (id) {
      void applyRecorderLayout(sourceOpen, true);
      setAuxMenu(id);
      return;
    }
    setAuxMenu(null);
    void applyRecorderLayout(sourceOpen, false);
  };

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

  return (
    <div className="relative w-fit">
      <div
        ref={barRef}
        className="flex items-center gap-1 rounded-2xl border border-border bg-card p-1.5"
      >
        <div
          data-tauri-drag-region
          className={cn(
            CTRL,
            "flex w-7 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing",
          )}
          title={t("recorder.drag")}
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
            open={sourceOpen && captureMode === "display"}
            onOpenChange={(open) => {
              if (open) useRecorderStore.getState().setCaptureMode("display");
              setSourceMenuOpen(open);
            }}
          />
          {caps?.canEnumerateSources !== false ? (
            <CaptureModeMenu
              mode="window"
              label={t("recorder.mode.window")}
              icon={<AppWindowIcon />}
              active={captureMode === "window"}
              open={sourceOpen && captureMode === "window"}
              onOpenChange={(open) => {
                if (open) useRecorderStore.getState().setCaptureMode("window");
                setSourceMenuOpen(open);
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
              open={sourceOpen && captureMode === "device"}
              onOpenChange={(open) => {
                if (open) useRecorderStore.getState().setCaptureMode("device");
                setSourceMenuOpen(open);
              }}
            />
          ) : null}
        </div>

        <Divider />

        <div className="flex shrink-0 items-center gap-0.5">
          <CameraMenu
            open={auxMenu === "camera"}
            onOpenChange={(open) => setAuxMenuOpen(open ? "camera" : null)}
          />
          <MicMenu
            open={auxMenu === "mic"}
            onOpenChange={(open) => setAuxMenuOpen(open ? "mic" : null)}
          />
          <AudioMenu
            open={auxMenu === "audio"}
            onOpenChange={(open) => setAuxMenuOpen(open ? "audio" : null)}
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
          open={auxMenu === "settings"}
          onOpenChange={(open) => setAuxMenuOpen(open ? "settings" : null)}
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <ModeBtn active={active} label={label} icon={icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-[min(28rem,calc(100vw-1.5rem))]")}
      >
        <SourceMenuContent mode={mode} onPick={() => onOpenChange(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-72")}
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
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-56")}
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
            onClick={() => void ensureCameraDevices()}
          >
            {t("recorder.camera.grant")}
          </button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-56")}
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
          <button
            type="button"
            className="w-full px-2 py-2 text-left text-xs text-primary hover:underline"
            onClick={() => void ensureMicrophoneDevices()}
          >
            {t("recorder.mic.grant")}
          </button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-52")}
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
      </DropdownMenuContent>
    </DropdownMenu>
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
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className={cn(MENU_CONTENT, "w-44")}
      >
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
      </DropdownMenuContent>
    </DropdownMenu>
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
          onClick={() => void refresh()}
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
      {source.kind === "display" ? (index ?? 0) + 1 : "🪟"}
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
