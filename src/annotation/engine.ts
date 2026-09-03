import { eraserStrokeRemovals } from "./geometry";
import type {
  AnnotationTool,
  EraserMode,
  HistoryItem,
  Point,
  ShapeKind,
  TextItem,
} from "./types";

const HIGHLIGHTER_ALPHA = 0.35;
// PowerPoint model: ink stays while the button is held, evaporates on release.
const LASER_FADE_MS = 900;
// A held drag grows the stroke unbounded, so cap it (oldest points drop first).
const LASER_STROKE_MAX_POINTS = 2000;
const TEXT_LINE_HEIGHT_MULTIPLIER = 1.2;
const TEXT_HIT_PADDING_X = 8;
const TEXT_HIT_PADDING_Y = 6;
const TEXT_FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif";
const TEXT_MIN_FONT_SIZE = 10;
const TEXT_MAX_FONT_SIZE = 160;
const TEXT_SELECTION_PADDING_X = 4;
const TEXT_SELECTION_PADDING_Y = 3;
const TEXT_RESIZE_HANDLE_RADIUS = 6;
const TEXT_RESIZE_HANDLE_HIT_RADIUS = 10;
const TEXT_SELECTION_STROKE = "#ef4444";
const TEXT_HANDLE_FILL = "#f8fafc";
const TEXT_HANDLE_STROKE = "#9ca3af";

type TextResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type TextBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const TEXT_RESIZE_HANDLES: TextResizeHandle[] = ["nw", "ne", "se", "sw"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Parse a #rrggbb color; falls back to laser red for anything else. */
function hexToRgb(color: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!m) {
    return { r: 239, g: 68, b: 68 };
  }
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function getResizeCursor(handle: TextResizeHandle): string {
  if (handle === "n" || handle === "s") {
    return "ns-resize";
  }
  if (handle === "e" || handle === "w") {
    return "ew-resize";
  }
  if (handle === "ne" || handle === "sw") {
    return "nesw-resize";
  }
  return "nwse-resize";
}

function getTextLineHeight(fontSize: number): number {
  return fontSize * TEXT_LINE_HEIGHT_MULTIPLIER;
}

function getTextFont(fontSize: number): string {
  return `${fontSize}px ${TEXT_FONT_FAMILY}`;
}

function setupCanvasContext(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    throw new Error("2d context unavailable");
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawSmoothPath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  close = false,
) {
  if (points.length < 2) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
  if (close) {
    ctx.closePath();
  }
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  headLen: number,
) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - headLen * Math.cos(angle - Math.PI / 6),
    y1 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - headLen * Math.cos(angle + Math.PI / 6),
    y1 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}

function renderHistoryItem(ctx: CanvasRenderingContext2D, item: HistoryItem) {
  switch (item.kind) {
    case "path": {
      if (item.points.length < 2) {
        return;
      }
      ctx.save();
      if (item.highlighter) {
        ctx.globalAlpha = HIGHLIGHTER_ALPHA;
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothPath(ctx, item.points);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "pixelErase": {
      if (item.points.length < 2) {
        return;
      }
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = item.radius * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothPath(ctx, item.points);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "shape": {
      const { x0, y0, x1, y1, color, width, shape } = item;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (shape === "rect") {
        const w = x1 - x0;
        const h = y1 - y0;
        ctx.strokeRect(x0, y0, w, h);
      } else if (shape === "ellipse") {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = Math.abs(x1 - x0) / 2;
        const ry = Math.abs(y1 - y0) / 2;
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          Math.max(1, rx),
          Math.max(1, ry),
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      } else if (shape === "line" || shape === "arrow") {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        if (shape === "arrow") {
          const head = Math.max(12, width * 3);
          drawArrowHead(ctx, x0, y0, x1, y1, head);
        }
      }
      ctx.restore();
      break;
    }
    case "text": {
      ctx.save();
      ctx.fillStyle = item.color;
      ctx.font = getTextFont(item.fontSize);
      ctx.textBaseline = "top";
      const lines = item.text.split("\n");
      lines.forEach((line, i) => {
        ctx.fillText(
          line,
          item.x,
          item.y + i * getTextLineHeight(item.fontSize),
        );
      });
      ctx.restore();
      break;
    }
    default:
      break;
  }
}

function redrawCommitted(
  ctx: CanvasRenderingContext2D,
  history: HistoryItem[],
  scrollX = 0,
  scrollY = 0,
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  ctx.save();
  ctx.translate(-scrollX, -scrollY);
  for (const item of history) {
    renderHistoryItem(ctx, item);
  }
  ctx.restore();
}

export class AnnotationEngine {
  private readonly viewCanvas: HTMLCanvasElement;
  private readonly offscreen: HTMLCanvasElement;
  private viewCtx: CanvasRenderingContext2D;
  private offCtx: CanvasRenderingContext2D;

  private history: HistoryItem[] = [];
  private redoStack: HistoryItem[] = [];

  tool: AnnotationTool = "pen";
  eraserMode: EraserMode = "pixel";
  shapeKind: ShapeKind = "rect";
  color = "#EAB308";
  brushSize = 6;
  highlighterSize = 28;
  eraserSize = 16;
  textFontSize = 18;

  private layerHidden = false;
  private raf: number | null = null;
  private needsFrame = false;

  private drawing = false;
  private currentPoints: Point[] = [];
  // Laser state is transient — never enters history, so undo/redo stay clean.
  private laserStroke: Point[] = [];
  private laserFading: { points: Point[]; t: number }[] = [];
  private laserPressed = false;
  private laserAt: Point | null = null;
  private shapeStart: Point | null = null;
  private textEditor: HTMLDivElement | null = null;
  private textEditorOpenTimer: number | null = null;
  private selectedTextIndex: number | null = null;
  private draggingSelectedText = false;
  private resizingSelectedText = false;
  private selectedTextDragPointerStart: Point | null = null;
  private selectedTextDragOrigin: Point | null = null;
  private selectedTextResizeHandle: TextResizeHandle | null = null;
  private selectedTextResizeAnchor: Point | null = null;
  private selectedTextResizeStartBounds: TextBounds | null = null;
  private selectedTextResizeStartHandlePoint: Point | null = null;
  private selectedTextResizeStartFontSize: number | null = null;
  private scrollRoot: Window | Element = window;

  constructor(viewCanvas: HTMLCanvasElement) {
    this.viewCanvas = viewCanvas;
    this.offscreen = document.createElement("canvas");
    const rect = () => ({
      w: window.innerWidth,
      h: window.innerHeight,
    });
    const { w, h } = rect();
    this.viewCtx = setupCanvasContext(viewCanvas, w, h);
    this.offCtx = setupCanvasContext(this.offscreen, w, h);
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);

    this.onResize = this.onResize.bind(this);
    this.onScroll = this.onScroll.bind(this);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("scroll", this.onScroll, {
      passive: true,
      capture: true,
    });
  }

  destroy() {
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("scroll", this.onScroll, true);
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.textEditorOpenTimer != null) {
      window.clearTimeout(this.textEditorOpenTimer);
      this.textEditorOpenTimer = null;
    }
    this.removeTextEditor();
  }

  setLayerHidden(hidden: boolean) {
    this.layerHidden = hidden;
    this.viewCanvas.style.opacity = hidden ? "0" : "1";
    this.viewCanvas.style.pointerEvents = hidden ? "none" : "auto";
  }

  getLayerHidden() {
    return this.layerHidden;
  }

  /**
   * Rebuild both canvas contexts and repaint committed strokes.
   *
   * Same work as a resize, exposed because a lost 2D context needs exactly
   * this: the old `CanvasRenderingContext2D` handles are dead, and the ink
   * only survives because `history` is plain data rather than pixels.
   */
  recoverContexts() {
    this.onResize();
  }

  /** True when the view canvas's 2D context has been lost by the compositor. */
  isContextLost(): boolean {
    // `isContextLost` is Chromium 117+; older engines simply never report loss.
    const ctx = this.viewCtx as CanvasRenderingContext2D & {
      isContextLost?: () => boolean;
    };
    return typeof ctx.isContextLost === "function" ? ctx.isContextLost() : false;
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.viewCtx = setupCanvasContext(this.viewCanvas, w, h);
    this.offCtx = setupCanvasContext(this.offscreen, w, h);
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  private onScroll() {
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  private getScrollOffset(): Point {
    if (this.scrollRoot instanceof Element) {
      return { x: this.scrollRoot.scrollLeft, y: this.scrollRoot.scrollTop };
    }
    return { x: window.scrollX, y: window.scrollY };
  }

  private applyToolCursor() {
    if (this.tool === "text") {
      this.viewCanvas.style.cursor = "text";
      return;
    }
    if (this.tool === "select") {
      this.viewCanvas.style.cursor = "default";
      return;
    }
    if (this.tool === "laser") {
      this.viewCanvas.style.cursor = "none";
      return;
    }
    this.viewCanvas.style.cursor = "crosshair";
  }

  private clearTextSelection() {
    this.selectedTextIndex = null;
    this.draggingSelectedText = false;
    this.resizingSelectedText = false;
    this.selectedTextDragPointerStart = null;
    this.selectedTextDragOrigin = null;
    this.selectedTextResizeHandle = null;
    this.selectedTextResizeAnchor = null;
    this.selectedTextResizeStartBounds = null;
    this.selectedTextResizeStartHandlePoint = null;
    this.selectedTextResizeStartFontSize = null;
  }

  private getTextBounds(item: TextItem): TextBounds {
    const lines = item.text.split("\n");
    const lineHeight = getTextLineHeight(item.fontSize);
    this.offCtx.save();
    this.offCtx.font = getTextFont(item.fontSize);
    const width = Math.max(
      4,
      ...lines.map(
        (line) => this.offCtx.measureText(line.length ? line : " ").width,
      ),
    );
    this.offCtx.restore();

    const height = Math.max(lineHeight, lines.length * lineHeight);
    return {
      left: item.x,
      top: item.y,
      width,
      height,
      right: item.x + width,
      bottom: item.y + height,
    };
  }

  private getSelectionFrame(bounds: TextBounds): TextBounds {
    const left = bounds.left - TEXT_SELECTION_PADDING_X;
    const top = bounds.top - TEXT_SELECTION_PADDING_Y;
    const right = bounds.right + TEXT_SELECTION_PADDING_X;
    const bottom = bounds.bottom + TEXT_SELECTION_PADDING_Y;

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  private getResizeHandlePoint(
    bounds: TextBounds,
    handle: TextResizeHandle,
  ): Point {
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    switch (handle) {
      case "nw":
        return { x: bounds.left, y: bounds.top };
      case "n":
        return { x: centerX, y: bounds.top };
      case "ne":
        return { x: bounds.right, y: bounds.top };
      case "e":
        return { x: bounds.right, y: centerY };
      case "se":
        return { x: bounds.right, y: bounds.bottom };
      case "s":
        return { x: centerX, y: bounds.bottom };
      case "sw":
        return { x: bounds.left, y: bounds.bottom };
      case "w":
        return { x: bounds.left, y: centerY };
      default:
        return { x: bounds.right, y: bounds.bottom };
    }
  }

  private getResizeAnchorPoint(
    bounds: TextBounds,
    handle: TextResizeHandle,
  ): Point {
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    switch (handle) {
      case "nw":
        return { x: bounds.right, y: bounds.bottom };
      case "n":
        return { x: centerX, y: bounds.bottom };
      case "ne":
        return { x: bounds.left, y: bounds.bottom };
      case "e":
        return { x: bounds.left, y: centerY };
      case "se":
        return { x: bounds.left, y: bounds.top };
      case "s":
        return { x: centerX, y: bounds.top };
      case "sw":
        return { x: bounds.right, y: bounds.top };
      case "w":
        return { x: bounds.right, y: centerY };
      default:
        return { x: bounds.left, y: bounds.top };
    }
  }

  private getSelectedTextResizeHandleAt(
    pageX: number,
    pageY: number,
  ): TextResizeHandle | null {
    if (this.selectedTextIndex == null) {
      return null;
    }

    const selected = this.history[this.selectedTextIndex];
    if (selected?.kind !== "text") {
      return null;
    }

    const frame = this.getSelectionFrame(this.getTextBounds(selected));
    const hitRadiusSquared =
      TEXT_RESIZE_HANDLE_HIT_RADIUS * TEXT_RESIZE_HANDLE_HIT_RADIUS;
    for (const handle of TEXT_RESIZE_HANDLES) {
      const point = this.getResizeHandlePoint(frame, handle);
      const dx = pageX - point.x;
      const dy = pageY - point.y;
      if (dx * dx + dy * dy <= hitRadiusSquared) {
        return handle;
      }
    }

    return null;
  }

  private getTextItemIndexAt(pageX: number, pageY: number): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i];
      if (item.kind !== "text") {
        continue;
      }
      const bounds = this.getTextBounds(item);
      if (
        pageX >= bounds.left - TEXT_HIT_PADDING_X &&
        pageX <= bounds.right + TEXT_HIT_PADDING_X &&
        pageY >= bounds.top - TEXT_HIT_PADDING_Y &&
        pageY <= bounds.bottom + TEXT_HIT_PADDING_Y
      ) {
        return i;
      }
    }
    return null;
  }

  private pickScrollRoot(clientX: number, clientY: number) {
    const rootNode = this.viewCanvas.getRootNode();
    const host =
      rootNode instanceof ShadowRoot ? (rootNode.host as HTMLElement) : null;
    const elements = document.elementsFromPoint(clientX, clientY);
    const target =
      elements.find((el) => !(host && (el === host || host.contains(el)))) ??
      document.documentElement;

    let node: Element | null = target;
    while (node) {
      const style = window.getComputedStyle(node);
      const canScrollY =
        (style.overflowY === "auto" ||
          style.overflowY === "scroll" ||
          style.overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight + 1;
      const canScrollX =
        (style.overflowX === "auto" ||
          style.overflowX === "scroll" ||
          style.overflowX === "overlay") &&
        node.scrollWidth > node.clientWidth + 1;
      if (canScrollY || canScrollX) {
        this.scrollRoot = node;
        return;
      }
      node = node.parentElement;
    }
    this.scrollRoot = window;
  }

  private scheduleFrame() {
    if (this.needsFrame) {
      return;
    }
    this.needsFrame = true;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.needsFrame = false;
      this.paint();
    });
  }

  private paint() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const { x: scrollX, y: scrollY } = this.getScrollOffset();
    this.viewCtx.save();
    this.viewCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.viewCtx.clearRect(0, 0, this.viewCanvas.width, this.viewCanvas.height);
    this.viewCtx.restore();
    this.viewCtx.drawImage(this.offscreen, 0, 0, w, h);

    if (this.tool === "select" && this.selectedTextIndex != null) {
      const selected = this.history[this.selectedTextIndex];
      if (selected?.kind === "text") {
        const bounds = this.getTextBounds(selected);
        const frame = this.getSelectionFrame(bounds);
        this.viewCtx.save();
        this.viewCtx.translate(-scrollX, -scrollY);
        this.viewCtx.setLineDash([]);
        this.viewCtx.lineWidth = 2;
        this.viewCtx.strokeStyle = TEXT_SELECTION_STROKE;
        this.viewCtx.strokeRect(
          frame.left,
          frame.top,
          frame.width,
          frame.height,
        );

        for (const handle of TEXT_RESIZE_HANDLES) {
          const point = this.getResizeHandlePoint(frame, handle);
          this.viewCtx.beginPath();
          this.viewCtx.fillStyle = TEXT_HANDLE_FILL;
          this.viewCtx.strokeStyle = TEXT_HANDLE_STROKE;
          this.viewCtx.lineWidth = 1;
          this.viewCtx.arc(
            point.x,
            point.y,
            TEXT_RESIZE_HANDLE_RADIUS,
            0,
            Math.PI * 2,
          );
          this.viewCtx.fill();
          this.viewCtx.stroke();
        }

        this.viewCtx.restore();
      } else {
        this.selectedTextIndex = null;
      }
    }

    if (this.tool === "laser") {
      this.renderLaser(scrollX, scrollY);
    }

    if (!this.drawing) {
      return;
    }

    if (
      (this.tool === "pen" || this.tool === "highlighter") &&
      this.currentPoints.length >= 2
    ) {
      this.viewCtx.save();
      if (this.tool === "highlighter") {
        this.viewCtx.globalAlpha = HIGHLIGHTER_ALPHA;
      }
      this.viewCtx.strokeStyle = this.color;
      this.viewCtx.lineWidth =
        this.tool === "highlighter" ? this.highlighterSize : this.brushSize;
      this.viewCtx.lineCap = "round";
      this.viewCtx.lineJoin = "round";
      this.viewCtx.translate(-scrollX, -scrollY);
      drawSmoothPath(this.viewCtx, this.currentPoints);
      this.viewCtx.stroke();
      this.viewCtx.restore();
    } else if (
      this.tool === "eraser" &&
      this.eraserMode === "pixel" &&
      this.currentPoints.length >= 2
    ) {
      this.viewCtx.save();
      this.viewCtx.globalCompositeOperation = "destination-out";
      this.viewCtx.strokeStyle = "rgba(0,0,0,1)";
      this.viewCtx.lineWidth = this.eraserSize * 2;
      this.viewCtx.lineCap = "round";
      this.viewCtx.lineJoin = "round";
      this.viewCtx.translate(-scrollX, -scrollY);
      drawSmoothPath(this.viewCtx, this.currentPoints);
      this.viewCtx.stroke();
      this.viewCtx.restore();
    } else if (
      this.tool === "eraser" &&
      this.eraserMode === "stroke" &&
      this.currentPoints.length >= 2
    ) {
      this.viewCtx.save();
      this.viewCtx.strokeStyle = "rgba(239,68,68,0.45)";
      this.viewCtx.lineWidth = this.eraserSize * 2;
      this.viewCtx.lineCap = "round";
      this.viewCtx.lineJoin = "round";
      this.viewCtx.translate(-scrollX, -scrollY);
      drawSmoothPath(this.viewCtx, this.currentPoints);
      this.viewCtx.stroke();
      this.viewCtx.restore();
    } else if (this.tool === "shape" && this.shapeStart) {
      const p0 = this.shapeStart;
      const p1 = this.currentPoints[this.currentPoints.length - 1] ?? p0;
      this.viewCtx.save();
      this.viewCtx.strokeStyle = this.color;
      this.viewCtx.lineWidth = this.brushSize;
      this.viewCtx.lineCap = "round";
      this.viewCtx.lineJoin = "round";
      this.viewCtx.translate(-scrollX, -scrollY);
      if (this.shapeKind === "rect") {
        this.viewCtx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      } else if (this.shapeKind === "ellipse") {
        const cx = (p0.x + p1.x) / 2;
        const cy = (p0.y + p1.y) / 2;
        const rx = Math.abs(p1.x - p0.x) / 2;
        const ry = Math.abs(p1.y - p0.y) / 2;
        this.viewCtx.beginPath();
        this.viewCtx.ellipse(
          cx,
          cy,
          Math.max(1, rx),
          Math.max(1, ry),
          0,
          0,
          Math.PI * 2,
        );
        this.viewCtx.stroke();
      } else if (this.shapeKind === "line" || this.shapeKind === "arrow") {
        this.viewCtx.beginPath();
        this.viewCtx.moveTo(p0.x, p0.y);
        this.viewCtx.lineTo(p1.x, p1.y);
        this.viewCtx.stroke();
        if (this.shapeKind === "arrow") {
          const head = Math.max(12, this.brushSize * 3);
          drawArrowHead(this.viewCtx, p0.x, p0.y, p1.x, p1.y, head);
        }
      }
      this.viewCtx.restore();
    }
  }

  private drawLaserInk(points: Point[], alpha: number, dotRadius: number) {
    if (points.length < 2 || alpha <= 0) {
      return;
    }
    const { r, g, b } = hexToRgb(this.color);
    const ctx = this.viewCtx;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Two passes: wide soft glow under a bright core.
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.28 * alpha})`;
    ctx.lineWidth = dotRadius * 2.6;
    drawSmoothPath(ctx, points);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.9 * alpha})`;
    ctx.lineWidth = dotRadius * 0.9;
    drawSmoothPath(ctx, points);
    ctx.stroke();
  }

  private renderLaser(scrollX: number, scrollY: number) {
    const now = performance.now();
    this.laserFading = this.laserFading.filter(
      (s) => now - s.t < LASER_FADE_MS,
    );

    const { r, g, b } = hexToRgb(this.color);
    const dotRadius = Math.max(5, this.brushSize * 1.1);
    const ctx = this.viewCtx;

    ctx.save();
    ctx.translate(-scrollX, -scrollY);
    // Additive blending makes overlapping glow read as heat, not mud.
    ctx.globalCompositeOperation = "lighter";

    for (const stroke of this.laserFading) {
      const life = 1 - (now - stroke.t) / LASER_FADE_MS;
      this.drawLaserInk(stroke.points, life * life, dotRadius);
    }
    this.drawLaserInk(this.laserStroke, 1, dotRadius);

    if (this.laserAt) {
      const { x, y } = this.laserAt;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, dotRadius * 3);
      halo.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
      halo.addColorStop(0.4, `rgba(${r},${g},${b},0.22)`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 3, 0, Math.PI * 2);
      ctx.fill();

      const core = ctx.createRadialGradient(x, y, 0, x, y, dotRadius);
      core.addColorStop(0, "rgba(255,255,255,0.95)");
      core.addColorStop(0.35, `rgba(${r},${g},${b},0.95)`);
      core.addColorStop(1, `rgba(${r},${g},${b},0.35)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    if (this.laserFading.length > 0) {
      this.scheduleFrame();
    }
  }

  private clearLaser() {
    this.laserStroke = [];
    this.laserFading = [];
    this.laserPressed = false;
    this.laserAt = null;
  }

  clientToCanvas(clientX: number, clientY: number): Point {
    const r = this.viewCanvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  private clientToPage(clientX: number, clientY: number): Point {
    const p = this.clientToCanvas(clientX, clientY);
    const s = this.getScrollOffset();
    return {
      x: p.x + s.x,
      y: p.y + s.y,
    };
  }

  setTool(t: AnnotationTool) {
    if (this.textEditorOpenTimer != null) {
      window.clearTimeout(this.textEditorOpenTimer);
      this.textEditorOpenTimer = null;
    }
    this.removeTextEditor();
    this.clearTextSelection();
    if (t !== "laser") {
      this.clearLaser();
    }
    this.tool = t;
    this.applyToolCursor();
    this.scheduleFrame();
  }

  isSelectTargetAtClientPoint(clientX: number, clientY: number): boolean {
    this.pickScrollRoot(clientX, clientY);
    const pointerPage = this.clientToPage(clientX, clientY);
    return (
      this.getSelectedTextResizeHandleAt(pointerPage.x, pointerPage.y) !=
        null || this.getTextItemIndexAt(pointerPage.x, pointerPage.y) != null
    );
  }

  clearSelectedTextSelection(): boolean {
    const hadSelection = this.selectedTextIndex != null;
    if (!hadSelection) {
      return false;
    }
    this.clearTextSelection();
    this.applyToolCursor();
    this.scheduleFrame();
    return true;
  }

  undo() {
    const last = this.history.pop();
    if (!last) {
      return;
    }
    this.redoStack.push(last);
    this.clearTextSelection();
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  redo() {
    const item = this.redoStack.pop();
    if (!item) {
      return;
    }
    this.history.push(item);
    this.clearTextSelection();
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  clearAll() {
    this.history = [];
    this.redoStack = [];
    this.clearTextSelection();
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  private pushHistory(item: HistoryItem) {
    this.history.push(item);
    this.redoStack = [];
    this.clearTextSelection();
    const { x, y } = this.getScrollOffset();
    redrawCommitted(this.offCtx, this.history, x, y);
    this.scheduleFrame();
  }

  pointerDown(e: PointerEvent) {
    if (this.tool === "select") {
      this.pickScrollRoot(e.clientX, e.clientY);
      const pointerPage = this.clientToPage(e.clientX, e.clientY);

      const handleAtPointer = this.getSelectedTextResizeHandleAt(
        pointerPage.x,
        pointerPage.y,
      );
      if (handleAtPointer) {
        const selected =
          this.selectedTextIndex == null
            ? null
            : this.history[this.selectedTextIndex];
        if (selected?.kind === "text") {
          const bounds = this.getTextBounds(selected);
          this.resizingSelectedText = true;
          this.draggingSelectedText = false;
          this.selectedTextResizeHandle = handleAtPointer;
          this.selectedTextResizeAnchor = this.getResizeAnchorPoint(
            bounds,
            handleAtPointer,
          );
          this.selectedTextResizeStartBounds = bounds;
          this.selectedTextResizeStartHandlePoint = this.getResizeHandlePoint(
            bounds,
            handleAtPointer,
          );
          this.selectedTextResizeStartFontSize = selected.fontSize;
          this.viewCanvas.style.cursor = getResizeCursor(handleAtPointer);
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          this.scheduleFrame();
          return;
        }
      }

      const selectedIndex = this.getTextItemIndexAt(
        pointerPage.x,
        pointerPage.y,
      );
      if (selectedIndex == null) {
        this.clearTextSelection();
        this.applyToolCursor();
        this.scheduleFrame();
        return;
      }

      const selectedText = this.history[selectedIndex];
      if (selectedText?.kind !== "text") {
        this.clearTextSelection();
        this.applyToolCursor();
        return;
      }

      this.selectedTextIndex = selectedIndex;
      this.draggingSelectedText = true;
      this.resizingSelectedText = false;
      this.selectedTextDragPointerStart = pointerPage;
      this.selectedTextDragOrigin = { x: selectedText.x, y: selectedText.y };
      this.selectedTextResizeHandle = null;
      this.selectedTextResizeAnchor = null;
      this.selectedTextResizeStartBounds = null;
      this.selectedTextResizeStartHandlePoint = null;
      this.selectedTextResizeStartFontSize = null;
      this.viewCanvas.style.cursor = "grabbing";
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.scheduleFrame();
      return;
    }

    if (this.tool === "laser") {
      this.pickScrollRoot(e.clientX, e.clientY);
      const p = this.clientToPage(e.clientX, e.clientY);
      this.laserAt = p;
      this.laserPressed = true;
      this.laserStroke = [p];
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.scheduleFrame();
      return;
    }

    if (this.tool === "text") {
      if (this.textEditorOpenTimer != null) {
        window.clearTimeout(this.textEditorOpenTimer);
      }
      this.clearTextSelection();
      const { clientX, clientY } = e;
      this.textEditorOpenTimer = window.setTimeout(() => {
        this.textEditorOpenTimer = null;
        if (this.tool !== "text") {
          return;
        }
        this.placeTextEditor(clientX, clientY);
      }, 0);
      return;
    }

    this.pickScrollRoot(e.clientX, e.clientY);
    const p = this.clientToPage(e.clientX, e.clientY);
    this.drawing = true;
    this.currentPoints = [p];

    if (this.tool === "shape") {
      this.shapeStart = p;
    }

    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.scheduleFrame();
  }

  pointerMove(e: PointerEvent) {
    if (this.tool === "select") {
      this.pickScrollRoot(e.clientX, e.clientY);
      const pointerPage = this.clientToPage(e.clientX, e.clientY);

      if (
        this.resizingSelectedText &&
        this.selectedTextIndex != null &&
        this.selectedTextResizeHandle &&
        this.selectedTextResizeAnchor &&
        this.selectedTextResizeStartBounds &&
        this.selectedTextResizeStartHandlePoint &&
        this.selectedTextResizeStartFontSize != null &&
        this.selectedTextResizeStartFontSize > 0
      ) {
        const item = this.history[this.selectedTextIndex];
        if (item?.kind === "text") {
          const handle = this.selectedTextResizeHandle;
          const anchor = this.selectedTextResizeAnchor;
          const startBounds = this.selectedTextResizeStartBounds;
          const startHandlePoint = this.selectedTextResizeStartHandlePoint;
          const startFontSize = this.selectedTextResizeStartFontSize;

          const initialDx = startHandlePoint.x - anchor.x;
          const initialDy = startHandlePoint.y - anchor.y;
          const currentDx = pointerPage.x - anchor.x;
          const currentDy = pointerPage.y - anchor.y;
          const safeInitialDx = Math.max(1, Math.abs(initialDx));
          const safeInitialDy = Math.max(1, Math.abs(initialDy));

          let scale = 1;
          if (handle === "n" || handle === "s") {
            scale = Math.abs(currentDy) / safeInitialDy;
          } else if (handle === "e" || handle === "w") {
            scale = Math.abs(currentDx) / safeInitialDx;
          } else {
            scale = Math.max(
              Math.abs(currentDx) / safeInitialDx,
              Math.abs(currentDy) / safeInitialDy,
            );
          }

          const nextFontSize = clamp(
            Math.round(startFontSize * Math.max(0.2, scale)),
            TEXT_MIN_FONT_SIZE,
            TEXT_MAX_FONT_SIZE,
          );
          const appliedScale = nextFontSize / startFontSize;
          const nextWidth = startBounds.width * appliedScale;
          const nextHeight = startBounds.height * appliedScale;

          let nextX = item.x;
          let nextY = item.y;
          if (handle === "nw") {
            nextX = anchor.x - nextWidth;
            nextY = anchor.y - nextHeight;
          } else if (handle === "n") {
            nextX = anchor.x - nextWidth / 2;
            nextY = anchor.y - nextHeight;
          } else if (handle === "ne") {
            nextX = anchor.x;
            nextY = anchor.y - nextHeight;
          } else if (handle === "e") {
            nextX = anchor.x;
            nextY = anchor.y - nextHeight / 2;
          } else if (handle === "se") {
            nextX = anchor.x;
            nextY = anchor.y;
          } else if (handle === "s") {
            nextX = anchor.x - nextWidth / 2;
            nextY = anchor.y;
          } else if (handle === "sw") {
            nextX = anchor.x - nextWidth;
            nextY = anchor.y;
          } else if (handle === "w") {
            nextX = anchor.x - nextWidth;
            nextY = anchor.y - nextHeight / 2;
          }

          item.fontSize = nextFontSize;
          item.x = nextX;
          item.y = nextY;
          this.redoStack = [];
          const { x, y } = this.getScrollOffset();
          redrawCommitted(this.offCtx, this.history, x, y);
          this.viewCanvas.style.cursor = getResizeCursor(handle);
          this.scheduleFrame();
        }
        return;
      }

      if (
        this.draggingSelectedText &&
        this.selectedTextIndex != null &&
        this.selectedTextDragPointerStart &&
        this.selectedTextDragOrigin
      ) {
        const item = this.history[this.selectedTextIndex];
        if (item?.kind === "text") {
          item.x =
            this.selectedTextDragOrigin.x +
            (pointerPage.x - this.selectedTextDragPointerStart.x);
          item.y =
            this.selectedTextDragOrigin.y +
            (pointerPage.y - this.selectedTextDragPointerStart.y);
          this.redoStack = [];
          const { x, y } = this.getScrollOffset();
          redrawCommitted(this.offCtx, this.history, x, y);
          this.scheduleFrame();
        }
        return;
      }

      const hoveredHandle = this.getSelectedTextResizeHandleAt(
        pointerPage.x,
        pointerPage.y,
      );
      if (hoveredHandle) {
        this.viewCanvas.style.cursor = getResizeCursor(hoveredHandle);
        return;
      }

      this.viewCanvas.style.cursor =
        this.getTextItemIndexAt(pointerPage.x, pointerPage.y) != null
          ? "grab"
          : "default";
      return;
    }

    if (this.tool === "laser") {
      const p = this.clientToPage(e.clientX, e.clientY);
      this.laserAt = p;
      if (this.laserPressed) {
        this.laserStroke.push(p);
        if (this.laserStroke.length > LASER_STROKE_MAX_POINTS) {
          this.laserStroke.splice(
            0,
            this.laserStroke.length - LASER_STROKE_MAX_POINTS,
          );
        }
      }
      this.scheduleFrame();
      return;
    }

    if (!this.drawing || this.tool === "text") {
      return;
    }
    const p = this.clientToPage(e.clientX, e.clientY);
    this.currentPoints.push(p);
    this.scheduleFrame();
  }

  pointerUp(e: PointerEvent) {
    if (this.tool === "select") {
      if (this.draggingSelectedText || this.resizingSelectedText) {
        try {
          (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }

        this.draggingSelectedText = false;
        this.resizingSelectedText = false;
        this.selectedTextDragPointerStart = null;
        this.selectedTextDragOrigin = null;
        this.selectedTextResizeHandle = null;
        this.selectedTextResizeAnchor = null;
        this.selectedTextResizeStartBounds = null;
        this.selectedTextResizeStartHandlePoint = null;
        this.selectedTextResizeStartFontSize = null;

        this.pickScrollRoot(e.clientX, e.clientY);
        const pointerPage = this.clientToPage(e.clientX, e.clientY);
        const hoveredHandle = this.getSelectedTextResizeHandleAt(
          pointerPage.x,
          pointerPage.y,
        );
        if (hoveredHandle) {
          this.viewCanvas.style.cursor = getResizeCursor(hoveredHandle);
        } else {
          this.viewCanvas.style.cursor =
            this.getTextItemIndexAt(pointerPage.x, pointerPage.y) != null
              ? "grab"
              : "default";
        }
        this.scheduleFrame();
      }
      return;
    }

    if (this.tool === "laser") {
      try {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      this.laserPressed = false;
      if (this.laserStroke.length >= 2) {
        this.laserFading.push({
          points: this.laserStroke,
          t: performance.now(),
        });
      }
      this.laserStroke = [];
      this.scheduleFrame();
      return;
    }

    if (!this.drawing || this.tool === "text") {
      return;
    }
    this.drawing = false;
    const pts = this.currentPoints;
    this.currentPoints = [];
    const start = this.shapeStart;
    this.shapeStart = null;

    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    if (this.tool === "pen" && pts.length >= 2) {
      this.pushHistory({
        kind: "path",
        points: pts,
        color: this.color,
        width: this.brushSize,
        highlighter: false,
      });
    } else if (this.tool === "highlighter" && pts.length >= 2) {
      this.pushHistory({
        kind: "path",
        points: pts,
        color: this.color,
        width: this.highlighterSize,
        highlighter: true,
      });
    } else if (this.tool === "eraser") {
      if (this.eraserMode === "pixel" && pts.length >= 2) {
        this.pushHistory({
          kind: "pixelErase",
          points: pts,
          radius: this.eraserSize,
        });
      } else if (this.eraserMode === "stroke" && pts.length >= 2) {
        const next = eraserStrokeRemovals(this.history, pts, this.eraserSize);
        if (next.length !== this.history.length) {
          this.history = next;
          this.redoStack = [];
          const { x, y } = this.getScrollOffset();
          redrawCommitted(this.offCtx, this.history, x, y);
        }
      }
      this.scheduleFrame();
    } else if (this.tool === "shape" && start && pts.length > 0) {
      const end = pts[pts.length - 1];
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      if (w > 2 || h > 2) {
        this.pushHistory({
          kind: "shape",
          shape: this.shapeKind,
          x0: start.x,
          y0: start.y,
          x1: end.x,
          y1: end.y,
          color: this.color,
          width: this.brushSize,
        });
      }
    }

    this.scheduleFrame();
  }

  private removeTextEditor() {
    if (this.textEditor) {
      this.textEditor.remove();
      this.textEditor = null;
    }
  }

  private normalizeCommittedText(rawText: string): string {
    return rawText
      .replace(/\u00A0/g, " ")
      .replace(/\r/g, "")
      .replace(/\n+$/, "");
  }

  private placeTextEditor(clientX: number, clientY: number) {
    this.removeTextEditor();
    const editor = document.createElement("div");
    const lineHeight = getTextLineHeight(this.textFontSize);
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Annotation text");
    editor.spellcheck = false;
    editor.style.position = "fixed";
    editor.style.left = `${clientX}px`;
    editor.style.top = `${clientY}px`;
    editor.style.minWidth = "1ch";
    editor.style.minHeight = `${Math.round(lineHeight)}px`;
    editor.style.maxWidth = `${Math.max(180, window.innerWidth - clientX - 12)}px`;
    editor.style.zIndex = "2147483647";
    editor.style.fontSize = `${this.textFontSize}px`;
    editor.style.fontFamily = TEXT_FONT_FAMILY;
    editor.style.lineHeight = String(TEXT_LINE_HEIGHT_MULTIPLIER);
    editor.style.fontWeight = "500";
    editor.style.color = this.color;
    editor.style.caretColor = this.color;
    editor.style.background = "transparent";
    editor.style.border = "none";
    editor.style.outline = "none";
    editor.style.padding = "0";
    editor.style.margin = "0";
    editor.style.whiteSpace = "pre-wrap";
    editor.style.wordBreak = "break-word";
    editor.style.overflow = "hidden";
    editor.style.textShadow = "0 1px 1px rgba(0,0,0,0.4)";

    const autoSize = () => {
      editor.style.height = "auto";
      editor.style.height = `${Math.max(Math.round(lineHeight), editor.scrollHeight)}px`;
    };

    document.body.appendChild(editor);
    this.textEditor = editor;
    autoSize();
    editor.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let committed = false;
    const commit = () => {
      if (committed) {
        return;
      }
      committed = true;
      const text = this.normalizeCommittedText(editor.innerText);
      const rect = editor.getBoundingClientRect();
      const origin = this.clientToPage(rect.left, rect.top);
      if (text.trim().length > 0) {
        this.pushHistory({
          kind: "text",
          x: origin.x,
          y: origin.y,
          text,
          color: this.color,
          fontSize: this.textFontSize,
        });
      }
      this.removeTextEditor();
      this.scheduleFrame();
    };

    editor.addEventListener("input", () => {
      autoSize();
    });

    editor.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        committed = true;
        this.removeTextEditor();
        this.scheduleFrame();
        return;
      }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        commit();
      }
    });
    editor.addEventListener("blur", () => {
      queueMicrotask(() => commit());
    });
  }

  async copyScreenshotToClipboard(): Promise<boolean> {
    try {
      const merged = document.createElement("canvas");
      merged.width = this.viewCanvas.width;
      merged.height = this.viewCanvas.height;
      const mctx = merged.getContext("2d");
      if (!mctx) {
        return false;
      }
      mctx.drawImage(this.viewCanvas, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        merged.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob || !navigator.clipboard?.write) {
        return false;
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  downloadScreenshot() {
    const merged = document.createElement("canvas");
    merged.width = this.viewCanvas.width;
    merged.height = this.viewCanvas.height;
    const mctx = merged.getContext("2d");
    if (!mctx) {
      return;
    }
    mctx.drawImage(this.viewCanvas, 0, 0);
    merged.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `capptivo-annotation-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }
}
