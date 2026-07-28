/** Full-screen drag-to-select overlay; coordinates are window-local logical points. */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { AreaRegionChrome } from "./AreaRegionChrome";

const MIN_SIZE = 48;
/** Visible dim + reliable hit-testing on macOS transparent windows. */
const CAPTURE_BG = "rgba(0, 0, 0, 0.45)";

type Rect = { x: number; y: number; width: number; height: number };

function normalizeRect(ax: number, ay: number, bx: number, by: number): Rect {
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return {
    x,
    y,
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export function AreaPickerApp() {
  const [rect, setRect] = useState<Rect | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const submitting = useRef(false);
  const rectRef = useRef<Rect | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    draggingRef.current = false;
    submitting.current = false;
    origin.current = null;
    setRect(null);
  }, []);

  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  useEffect(() => {
    const unlisten = listen("area-picker://reset", () => reset());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [reset]);

  const cancel = useCallback(() => {
    if (submitting.current) return;
    void commands.cancelAreaPick();
  }, []);

  const complete = useCallback(async (r: Rect) => {
    if (submitting.current) return;
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
      setRect(null);
      return;
    }
    submitting.current = true;
    try {
      await commands.completeAreaPick(r.x, r.y, r.width, r.height);
    } catch {
      submitting.current = false;
      setRect(null);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0 || submitting.current) return;
    e.preventDefault();
    e.stopPropagation();
    const el = captureRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    draggingRef.current = true;
    setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current || !origin.current) return;
    setRect(
      normalizeRect(origin.current.x, origin.current.y, e.clientX, e.clientY),
    );
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const start = origin.current;
      origin.current = null;
      const final =
        start != null
          ? normalizeRect(start.x, start.y, e.clientX, e.clientY)
          : rectRef.current;
      setRect(final);
      const el = captureRef.current;
      if (el?.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      if (!final) return;
      void complete(final);
    },
    [complete],
  );

  useEffect(() => {
    const el = captureRef.current;
    if (!el) return;
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", reset);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", reset);
    };
  }, [onPointerDown, onPointerMove, onPointerUp, reset]);

  const hint =
    rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE
      ? `${Math.round(rect.width)} × ${Math.round(rect.height)}`
      : "Drag to select · Esc to cancel";

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Hit target — must paint with non-zero alpha on macOS */}
      <div
        ref={captureRef}
        className="absolute inset-0 z-10 cursor-crosshair select-none touch-none"
        style={{ backgroundColor: CAPTURE_BG }}
      />

      {/* Hole punch + brighter selection (visual only) */}
      <div className="pointer-events-none absolute inset-0 z-20">
        {rect && rect.width > 0 && rect.height > 0 && (
          <>
            <AreaRegionChrome rect={rect} />
            <div
              className="absolute rounded-sm bg-sky-400/10"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            >
              <div className="absolute bottom-2 right-2 rounded-md bg-black/80 px-2 py-1 text-xs font-medium tabular-nums text-white">
                {Math.round(rect.width)} × {Math.round(rect.height)}
              </div>
            </div>
          </>
        )}
        <div className="absolute left-1/2 top-6 -translate-x-1/2">
          <div className="rounded-full bg-black/75 px-4 py-2 text-sm font-medium text-white shadow-lg">
            {hint}
          </div>
        </div>
      </div>
    </div>
  );
}
