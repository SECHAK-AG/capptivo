import { Scissors } from "lucide-react";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { formatTimelineTime } from "../lib/timelineMath";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  start: number;
  end: number;
  selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

/** Rose trim-gap segment — same chrome as zoom, different palette. */
export function TrimTimelineBlock({ start, end, selected, onResizePointerDown }: Props) {
  const { t } = useI18n();
  const range = `${formatTimelineTime(start)}–${formatTimelineTime(end)}`;

  return (
    <div
      className={cn(
        "group/trim relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border border-rose-300/80 bg-[#c23a5a] shadow-[inset_0_0_0_1px_rgba(251,113,133,0.45)]"
          : "border border-transparent bg-gradient-to-r from-[#9e2d48] via-[#b33554] to-[#c23a5a] hover:from-[#b33554] hover:via-[#c23a5a] hover:to-[#d44868]",
      )}
    >
      <TimelineResizePill
        edge="start"
        hoverGroup="trim"
        show={selected}
        onPointerDown={(e) => onResizePointerDown("start", e)}
      />
      <TimelineResizePill
        edge="end"
        hoverGroup="trim"
        show={selected}
        onPointerDown={(e) => onResizePointerDown("end", e)}
      />

      <div className="pointer-events-none relative z-10 flex max-w-full flex-col items-center justify-center px-3 py-0.5 text-white select-none">
        <div className="flex items-center gap-1">
          <Scissors className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="text-[11px] font-semibold tracking-tight">{t("timeline.trim")}</span>
        </div>
        <div
          className={cn(
            "text-[9px] font-medium tracking-tight tabular-nums text-white/85",
            selected ? "opacity-75" : "opacity-0 transition-opacity group-hover/trim:opacity-60",
          )}
        >
          <span className="whitespace-nowrap">{range}</span>
        </div>
      </div>
    </div>
  );
}
