/**
 * In-recording annotation overlay — same engine as the Capptivo extension,
 * with a vertical toolbar styled like the desktop recorder bar.
 */

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import {
  Brush,
  Check,
  Circle,
  Eraser,
  GripVertical,
  Highlighter,
  Minus,
  MousePointer2,
  MoveUpRight,
  Paintbrush,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";

import { AnnotationEngine } from "@/annotation/engine";
import type { AnnotationTool, ShapeKind } from "@/annotation/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { commands } from "@/ipc/bindings";
import { cn } from "@/lib/utils";

/** Preset swatches — custom colors come from the picker tile after these. */
const PALETTE = [
  "#EAB308",
  "#f97316",
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#ffffff",
  "#000000",
];

const MENU =
  "rounded-xl border-border/80 bg-popover p-1.5 shadow-lg ring-1 ring-border/40";

const SHAPES: { id: ShapeKind; label: string; icon: ReactNode }[] = [
  { id: "rect", label: "Rectangle", icon: <Square className="size-4" /> },
  { id: "ellipse", label: "Ellipse", icon: <Circle className="size-4" /> },
  { id: "line", label: "Line", icon: <Minus className="size-4" /> },
  { id: "arrow", label: "Arrow", icon: <MoveUpRight className="size-4" /> },
];

type ToolId = AnnotationTool;
type Panel = "color" | "shape" | "size" | null;

/** Toolbar transform: `translate3d` keeps the bar on its own GPU layer. */
function barTransform(x: number, y: number): string {
  return `translate3d(${x}px, calc(-50% + ${y}px), 0)`;
}

export function AnnotationApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AnnotationEngine | null>(null);
  // Pass-through until the user picks a drawing tool — otherwise the overlay
  // steals every click from the Mac.
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState(PALETTE[0]!);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [brushSize, setBrushSize] = useState(6);
  const [panel, setPanel] = useState<Panel>(null);
  const [barOffset, setBarOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  /** True for the whole grip gesture — read by the click-through poll. */
  const draggingRef = useRef(false);
  /** Latest drag offset, committed to state once on release. */
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const dragRafRef = useRef(0);
  const toolbarElRef = useRef<HTMLDivElement | null>(null);
  const ignoreRef = useRef(false);
  // The overlay WebView is reused (Rust show/hide, never closed), so this app
  // stays mounted while hidden. Track native visibility to suspend the idle
  // cursor-poll when off-screen — the window is created to be shown, so `true`.
  const [overlayVisible, setOverlayVisible] = useState(true);

  const passThrough = tool === "select" && panel === null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new AnnotationEngine(canvas);
    engine.color = color;
    engine.brushSize = brushSize;
    engine.highlighterSize = Math.max(12, brushSize * 4);
    engine.eraserSize = Math.max(8, brushSize * 2.5);
    engine.setTool(tool);
    engineRef.current = engine;

    const onDown = (e: PointerEvent) => engine.pointerDown(e);
    const onMove = (e: PointerEvent) => engine.pointerMove(e);
    const onUp = (e: PointerEvent) => engine.pointerUp(e);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      engine.destroy();
      engineRef.current = null;
      void getCurrentWindow().setIgnoreCursorEvents(false).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setTool(tool);
    canvasRef.current?.classList.toggle("pointer-events-none", tool === "select");
  }, [tool]);

  const applyIgnore = (ignore: boolean) => {
    if (ignoreRef.current === ignore) return;
    ignoreRef.current = ignore;
    void getCurrentWindow().setIgnoreCursorEvents(ignore).catch(() => undefined);
  };

  // Native show/hide from Rust (`annotation://visibility`). Keeps `overlayVisible`
  // in sync so the idle poll below can stop while the overlay is off-screen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<boolean>("annotation://visibility", (e) => setOverlayVisible(e.payload)).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // OS click-through while idle. `setIgnoreCursorEvents` blocks ALL hits (including
  // the toolbar), so we poll the real cursor and temporarily re-enable hits when
  // it's over the bar / left-side menus. Suspended while the overlay is hidden —
  // no point running ~37 IPC round-trips/sec against an off-screen window.
  useEffect(() => {
    if (!passThrough || !overlayVisible) {
      // Only reset click-through when the tool actually allows hits; when merely
      // hidden, leave the ignore state as-is (it's re-evaluated on re-show).
      if (!passThrough) applyIgnore(false);
      return;
    }

    let cancelled = false;
    let timer = 0;
    // Follow the cursor's display at a slower cadence than hit-testing
    // (~every 6th tick ≈ 0.5 s): the overlay hops monitors like the recorder
    // bar, but only in click-through mode — never mid-annotation.
    let displayTick = 0;

    const tick = async () => {
      if (cancelled) return;
      if (!draggingRef.current && ++displayTick >= 6) {
        displayTick = 0;
        void commands.syncAnnotationDisplay().catch(() => undefined);
      }
      // Never re-evaluate hit-testing mid-drag: the async cursor/rect reads
      // race the moving bar, and one stale "not over the bar" answer flips
      // `setIgnoreCursorEvents(true)` under an active pointer capture —
      // cutting the event stream (the bar stalls) and churning the window's
      // event shadow every 80 ms (the flicker).
      if (draggingRef.current) {
        applyIgnore(false);
        timer = window.setTimeout(tick, 80);
        return;
      }
      const el = toolbarElRef.current;
      if (!el) {
        applyIgnore(true);
        timer = window.setTimeout(tick, 80);
        return;
      }
      try {
        const win = getCurrentWindow();
        const [cursor, scale, outer] = await Promise.all([
          cursorPosition(),
          win.scaleFactor(),
          win.outerPosition(),
        ]);
        if (cancelled) return;
        const x = (cursor.x - outer.x) / scale;
        const y = (cursor.y - outer.y) / scale;
        const r = el.getBoundingClientRect();
        // Extra left pad so color/shape/size menus stay interactive.
        const over =
          x >= r.left - 220 &&
          x <= r.right + 12 &&
          y >= r.top - 12 &&
          y <= r.bottom + 12;
        applyIgnore(!over);
      } catch {
        applyIgnore(true);
      }
      timer = window.setTimeout(tick, 80);
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [passThrough, overlayVisible]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.color = color;
  }, [color]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.shapeKind = shapeKind;
  }, [shapeKind]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.brushSize = brushSize;
    engine.highlighterSize = Math.max(12, brushSize * 4);
    engine.eraserSize = Math.max(8, brushSize * 2.5);
  }, [brushSize]);

  /** Activate `next`, or return to pass-through if it was already active. */
  const pickTool = (next: ToolId) => {
    setTool((t) => (t === next && next !== "select" ? "select" : next));
    setPanel(null);
  };

  /** End the grip gesture: commit the final offset to state (so re-renders
   * keep the position) and release the drag refs. Shared by up/cancel/capture
   * loss so no path can leave the poll pinned in "dragging". */
  const endBarDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    dragRef.current = null;
    if (dragRafRef.current !== 0) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    setBarOffset(dragOffsetRef.current);
  };

  const shapeIcon = SHAPES.find((s) => s.id === shapeKind)?.icon ?? (
    <Square className="size-4" />
  );

  return (
    // `select-none` is load-bearing: a grip drag otherwise starts a browser
    // *content selection* that sweeps over the full-viewport canvas — WebKit
    // paints the blue selection tint across the selected canvas's entire box,
    // i.e. the whole screen, until mouse-up.
    <div className="annotation-shell relative h-screen w-screen overflow-hidden bg-transparent select-none">
      <canvas
        ref={canvasRef}
        className={cn(
          "absolute inset-0 h-full w-full touch-none",
          tool === "select" ? "pointer-events-none cursor-default" : "cursor-crosshair",
        )}
      />

      <div
        ref={toolbarElRef}
        // `will-change-transform` promotes the bar to its own compositor
        // layer: moving it re-composites only the bar. Without it, WebKit can
        // repaint the whole viewport for a fixed-position transform change —
        // on a transparent overlay window that full-surface repaint flashes
        // the desktop through for a frame.
        // Vertically centered: the bar is tall, and anchoring it low (was 72%)
        // clipped the bottom tools into the Dock on smaller displays.
        className="fixed top-1/2 right-6 z-10 flex w-12 flex-col items-center gap-0.5 rounded-2xl border border-border bg-card p-1.5 shadow-xl will-change-transform"
        style={{ transform: barTransform(barOffset.x, barOffset.y) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex h-8 w-full cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
          title="Drag"
          onPointerDown={(e) => {
            // Belt and braces with the shell's select-none: never let the
            // grip press begin a selection or native content drag.
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            draggingRef.current = true;
            dragOffsetRef.current = barOffset;
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              origX: barOffset.x,
              origY: barOffset.y,
            };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d) return;
            // Keep the grip below the macOS menu bar so the bar stays draggable.
            const nextY = d.origY + (e.clientY - d.startY);
            dragOffsetRef.current = {
              x: d.origX + (e.clientX - d.startX),
              y: Math.max(nextY, -window.innerHeight * 0.2),
            };
            // Mutate the style directly, coalesced to one update per frame —
            // a React re-render per pointermove is what made the drag lag.
            if (dragRafRef.current === 0) {
              dragRafRef.current = requestAnimationFrame(() => {
                dragRafRef.current = 0;
                const el = toolbarElRef.current;
                const { x, y } = dragOffsetRef.current;
                if (el) el.style.transform = barTransform(x, y);
              });
            }
          }}
          onPointerUp={endBarDrag}
          onPointerCancel={endBarDrag}
          onLostPointerCapture={endBarDrag}
        >
          <GripVertical className="pointer-events-none size-4" />
        </div>

        <Divider />

        <ToolBtn
          label="Click through"
          active={false}
          onClick={() => pickTool("select")}
          icon={<MousePointer2 className="size-4" />}
        />
        <ToolBtn
          label="Pen"
          active={tool === "pen"}
          onClick={() => pickTool("pen")}
          icon={<Paintbrush className="size-4" />}
        />
        <ToolBtn
          label="Highlighter"
          active={tool === "highlighter"}
          onClick={() => pickTool("highlighter")}
          icon={<Highlighter className="size-4" />}
        />
        <ToolBtn
          label="Eraser"
          active={tool === "eraser"}
          onClick={() => pickTool("eraser")}
          icon={<Eraser className="size-4" />}
        />

        <DropdownMenu
          open={panel === "shape"}
          onOpenChange={(open) => {
            if (open) {
              setTool("shape");
              setPanel("shape");
            } else if (panel === "shape") {
              setPanel(null);
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <ToolBtn
              label="Shape"
              active={tool === "shape" || panel === "shape"}
              icon={shapeIcon}
              onClick={(e) => {
                // Second click on an active shape tool → back to click-through.
                if (tool === "shape") {
                  e.preventDefault();
                  setTool("select");
                  setPanel(null);
                }
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="left"
            align="center"
            sideOffset={10}
            className={cn(MENU, "w-44")}
          >
            {SHAPES.map((s) => (
              <DropdownMenuItem
                key={s.id}
                className="gap-2 rounded-md"
                onSelect={() => {
                  setShapeKind(s.id);
                  setTool("shape");
                }}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    shapeKind === s.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="shrink-0 text-muted-foreground">{s.icon}</span>
                <span className="min-w-0 flex-1">{s.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolBtn
          label="Text"
          active={tool === "text"}
          onClick={() => pickTool("text")}
          icon={<Type className="size-4" />}
        />

        <DropdownMenu
          open={panel === "color"}
          onOpenChange={(open) => setPanel(open ? "color" : panel === "color" ? null : panel)}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Color"
              aria-label="Color"
              className={cn(
                "flex size-9 items-center justify-center rounded-xl transition-colors hover:bg-muted",
                panel === "color" && "bg-muted",
              )}
            >
              <span
                className="size-4 rounded-full ring-1 ring-border"
                style={{ backgroundColor: color }}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="left"
            align="center"
            sideOffset={10}
            className={cn(MENU, "w-46")}
          >
            <p className="px-2 pt-1 pb-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Color
            </p>
            <div className="grid grid-cols-4 gap-2 px-1.5 pb-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => {
                    setColor(c);
                    setPanel(null);
                  }}
                  className={cn(
                    "size-8 rounded-lg ring-1 ring-border transition-transform hover:scale-105",
                    c.toLowerCase() === color.toLowerCase() && "ring-2 ring-primary",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
              <label
                title="Custom color"
                className={cn(
                  "relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border transition-transform hover:scale-105",
                  !PALETTE.some((c) => c.toLowerCase() === color.toLowerCase()) &&
                    "ring-2 ring-primary",
                )}
                style={
                  !PALETTE.some((c) => c.toLowerCase() === color.toLowerCase())
                    ? { backgroundColor: color }
                    : undefined
                }
              >
                <Pipette className="pointer-events-none relative z-10 size-3.5 text-foreground drop-shadow" />
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#EAB308"}
                  aria-label="Custom color"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={(e) => setColor(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </label>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu
          open={panel === "size"}
          onOpenChange={(open) => setPanel(open ? "size" : panel === "size" ? null : panel)}
        >
          <DropdownMenuTrigger asChild>
            <ToolBtn
              label="Brush size"
              active={panel === "size"}
              icon={<Brush className="size-4" />}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="left"
            align="center"
            sideOffset={10}
            className={cn(MENU, "w-52 p-3")}
          >
            <p className="mb-3 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Brush size
            </p>
            <div className="flex items-center gap-3">
              <Slider
                min={2}
                max={24}
                step={1}
                value={[brushSize]}
                onValueChange={(v) => setBrushSize(v[0] ?? 6)}
                className="flex-1"
              />
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                {brushSize}
              </span>
            </div>
            <div className="mt-3 flex justify-center">
              <span
                className="rounded-full bg-foreground"
                style={{ width: brushSize, height: brushSize }}
              />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Divider />

        <ToolBtn
          label="Undo"
          onClick={() => engineRef.current?.undo()}
          icon={<Undo2 className="size-4" />}
        />
        <ToolBtn
          label="Redo"
          onClick={() => engineRef.current?.redo()}
          icon={<Redo2 className="size-4" />}
        />
        <ToolBtn
          label="Clear"
          onClick={() => engineRef.current?.clearAll()}
          icon={<Trash2 className="size-4" />}
        />

        <Divider />

        <ToolBtn
          label="Close"
          onClick={() => {
            // Recorder HUD listens — separate WebView, so sync via event.
            void emit("annotation://closed");
            void getCurrentWindow().hide();
            void commands.hideAnnotationOverlay().catch(() => undefined);
          }}
          icon={<X className="size-4" />}
        />
      </div>
    </div>
  );
}

const ToolBtn = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    icon: ReactNode;
    active?: boolean;
  } & ComponentPropsWithoutRef<"button">
>(({ label, icon, active, className, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="icon"
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={cn(
      "size-9 shrink-0 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground",
      "data-[state=open]:bg-muted data-[state=open]:text-foreground",
      active && "bg-primary/20 text-primary hover:bg-primary/20 hover:text-primary",
      className,
    )}
    {...props}
  >
    {icon}
  </Button>
));

function Divider() {
  return <div className="my-0.5 h-px w-7 bg-border" />;
}
