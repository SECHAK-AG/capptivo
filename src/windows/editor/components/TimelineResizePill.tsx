import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";

export type TimelineResizeEdge = "start" | "end";

type TimelineResizePillProps = {
  edge: TimelineResizeEdge;
  show: boolean;
  /** Tailwind group name used by the parent (`group/zoom`, `group/trim`). */
  hoverGroup: "zoom" | "trim";
  onPointerDown: (e: React.PointerEvent) => void;
};

/** Thin white edge handle shared by zoom + trim timeline blocks. */
export function TimelineResizePill({
  edge,
  show,
  hoverGroup,
  onPointerDown,
}: TimelineResizePillProps) {
  const { t } = useI18n();
  const hoverVisible =
    hoverGroup === "zoom"
      ? "group-hover/zoom:opacity-100 group-hover/zoom:pointer-events-auto"
      : "group-hover/trim:opacity-100 group-hover/trim:pointer-events-auto";

  return (
    <button
      type="button"
      data-handle
      aria-label={edge === "start" ? t("timeline.resizeStart") : t("timeline.resizeEnd")}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute top-1/2 z-20 h-[70%] w-1 -translate-y-1/2 cursor-ew-resize rounded-full bg-white/90 shadow-sm transition-opacity",
        edge === "start" ? "left-1.5" : "right-1.5",
        show ? "opacity-100" : cn("pointer-events-none opacity-0", hoverVisible),
      )}
    />
  );
}
