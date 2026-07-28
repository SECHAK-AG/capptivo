import type { LucideIcon } from "lucide-react";
import {
  MousePointer2,
  Settings,
  Video,
  Wallpaper,
  ZoomIn,
} from "lucide-react";
import type { ReactNode } from "react";

import { ClosedCaption } from "@/components/icons/ClosedCaption";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";

export const INSPECTOR_PANEL_IDS = [
  "look",
  "cursor",
  "camera",
  "zoom",
  "captions",
  "config",
] as const;

export type InspectorPanelId = (typeof INSPECTOR_PANEL_IDS)[number];

const PANEL_META: Record<
  InspectorPanelId,
  { icon: LucideIcon; titleKey: TranslationKey; subtitleKey: TranslationKey }
> = {
  look: {
    icon: Wallpaper,
    titleKey: "panel.look.title",
    subtitleKey: "panel.look.subtitle",
  },
  cursor: {
    icon: MousePointer2,
    titleKey: "panel.cursor.title",
    subtitleKey: "panel.cursor.subtitle",
  },
  camera: {
    icon: Video,
    titleKey: "panel.camera.title",
    subtitleKey: "panel.camera.subtitle",
  },
  zoom: {
    icon: ZoomIn,
    titleKey: "panel.zoom.title",
    subtitleKey: "panel.zoom.subtitle",
  },
  captions: {
    icon: ClosedCaption,
    titleKey: "panel.captions.title",
    subtitleKey: "panel.captions.subtitle",
  },
  config: {
    icon: Settings,
    titleKey: "panel.config.title",
    subtitleKey: "panel.config.subtitle",
  },
};

type InspectorChromeProps = {
  activePanel: InspectorPanelId;
  onPanelChange: (id: InspectorPanelId) => void;
  /** When false, the Face cam rail item is disabled. */
  hasFaceCam?: boolean;
  /** Capptivo logo — switch this window to the recordings library. */
  onOpenRecordings: () => void;
  /** Scrollable body for the active panel only. */
  children: ReactNode;
};

/**
 * Narrow icon rail + wide inspector column (double sidebar), left of the canvas.
 */
export function InspectorChrome({
  activePanel,
  onPanelChange,
  hasFaceCam = false,
  onOpenRecordings,
  children,
}: InspectorChromeProps) {
  const { t } = useI18n();

  return (
    <div className="flex h-full shrink-0 border-r border-border bg-background text-foreground">
      <nav
        className="flex w-14 shrink-0 flex-col items-center border-r border-border py-3"
        aria-label={t("panel.config.title")}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Open recordings"
              title="Recordings"
              onClick={onOpenRecordings}
              className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-black/4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-accent/60"
            >
              <img
                src="/logo.svg"
                alt=""
                className="size-6 object-contain"
                decoding="async"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Recordings</TooltipContent>
        </Tooltip>

        <div className="mt-4 flex flex-1 flex-col items-center gap-1">
          {INSPECTOR_PANEL_IDS.map((id) => {
            const meta = PANEL_META[id];
            const Icon = meta.icon;
            const isActive = activePanel === id;
            const disabled = id === "camera" && !hasFaceCam;
            const title = disabled
              ? t("panel.camera.disabled")
              : t(meta.titleKey);

            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  {/* Span keeps tooltip working when the button is disabled. */}
                  <span className="inline-flex size-10 items-center justify-center">
                    <button
                      type="button"
                      aria-label={title}
                      aria-pressed={isActive}
                      disabled={disabled}
                      onClick={() => onPanelChange(id)}
                      className={cn(
                        "flex size-10 flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 transition-colors",
                        disabled &&
                          "cursor-not-allowed opacity-40 text-muted-foreground",
                        !disabled && isActive
                          ? // Light: warm peach + rust (matches brand). Dark: neutral chip.
                            "bg-primary/12 text-primary ring-1 ring-primary/20 dark:bg-accent dark:text-accent-foreground dark:ring-border"
                          : !disabled &&
                              "text-muted-foreground hover:bg-black/4 hover:text-foreground dark:hover:bg-accent/60 dark:hover:text-foreground",
                      )}
                    >
                      <Icon className="size-5 shrink-0" strokeWidth={1.75} />
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">{title}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </nav>

      <aside className="flex w-[min(380px,calc(100vw-3.5rem))] max-w-[420px] min-w-[280px] shrink-0 flex-col border-r border-border bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              {t(PANEL_META[activePanel].titleKey)}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(PANEL_META[activePanel].subtitleKey)}
            </p>
          </div>
          <div className="p-5">{children}</div>
        </div>
      </aside>
    </div>
  );
}
