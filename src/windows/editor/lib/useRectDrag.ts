import { useCallback, useRef, useState } from "react";
import { hitTestHandle } from "@/engine";

import { CROP_HANDLE_SIZE, getHandleCursor } from "./cropHandles";

export type NormRect = { x: number; y: number; width: number; height: number };

export type RectHit = {
  key: string;
  rect: NormRect;
  handle: string | null;
};

type PixelRect = { x: number; y: number; width: number; height: number };

type Interaction = {
  key: string;
  handle: string | null;
  startX: number;
  startY: number;
  startRect: PixelRect;
};

export function toPixelRect(
  rect: NormRect,
  width: number,
  height: number,
): PixelRect {
  return {
    x: rect.x * width,
    y: rect.y * height,
    width: rect.width * width,
    height: rect.height * height,
  };
}

export function hitHandleAt(
  localX: number,
  localY: number,
  rect: NormRect,
  width: number,
  height: number,
): string | null {
  return hitTestHandle(
    localX,
    localY,
    toPixelRect(rect, width, height),
    CROP_HANDLE_SIZE,
  );
}

export function containsPoint(
  localX: number,
  localY: number,
  rect: NormRect,
  width: number,
  height: number,
): boolean {
  const px = toPixelRect(rect, width, height);
  return (
    localX >= px.x &&
    localX <= px.x + px.width &&
    localY >= px.y &&
    localY <= px.y + px.height
  );
}

export function resizePixelRect(
  startRect: PixelRect,
  handle: string,
  dx: number,
  dy: number,
): PixelRect {
  let { x, y, width, height } = startRect;
  if (handle.includes("e")) width = startRect.width + dx;
  if (handle.includes("w")) {
    x = startRect.x + dx;
    width = startRect.width - dx;
  }
  if (handle.includes("s")) height = startRect.height + dy;
  if (handle.includes("n")) {
    y = startRect.y + dy;
    height = startRect.height - dy;
  }
  return { x, y, width, height };
}

export function useRectDrag(params: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  pick: (
    localX: number,
    localY: number,
    width: number,
    height: number,
  ) => RectHit | null;
  onChange: (key: string, next: NormRect) => void;
  onPick?: (key: string | null) => void;
}) {
  const { stageRef, disabled = false, pick, onChange, onPick } = params;
  const pointerIdRef = useRef<number | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [cursor, setCursor] = useState("default");

  const bounds = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return null;
    const b = stage.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? b : null;
  }, [stageRef]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      const b = bounds();
      if (!b) return;

      const localX = e.clientX - b.left;
      const localY = e.clientY - b.top;
      const hit = pick(localX, localY, b.width, b.height);
      if (!hit) {
        onPick?.(null);
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      onPick?.(hit.key);
      stageRef.current?.setPointerCapture(e.pointerId);
      pointerIdRef.current = e.pointerId;
      interactionRef.current = {
        key: hit.key,
        handle: hit.handle,
        startX: localX,
        startY: localY,
        startRect: toPixelRect(hit.rect, b.width, b.height),
      };
    },
    [bounds, disabled, onPick, pick, stageRef],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const b = bounds();
      if (!b) return;
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) {
        return;
      }

      const localX = e.clientX - b.left;
      const localY = e.clientY - b.top;
      const inter = interactionRef.current;

      if (inter) {
        const dx = localX - inter.startX;
        const dy = localY - inter.startY;
        const next = inter.handle
          ? resizePixelRect(inter.startRect, inter.handle, dx, dy)
          : {
              ...inter.startRect,
              x: inter.startRect.x + dx,
              y: inter.startRect.y + dy,
            };
        onChange(inter.key, {
          x: next.x / b.width,
          y: next.y / b.height,
          width: next.width / b.width,
          height: next.height / b.height,
        });
        return;
      }

      const hover = pick(localX, localY, b.width, b.height);
      setCursor(
        hover?.handle ? getHandleCursor(hover.handle) : hover ? "move" : "default",
      );
    },
    [bounds, onChange, pick],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerIdRef.current) return;
      if (stageRef.current?.hasPointerCapture(e.pointerId)) {
        stageRef.current.releasePointerCapture(e.pointerId);
      }
      pointerIdRef.current = null;
      interactionRef.current = null;
    },
    [stageRef],
  );

  const onPointerLeave = useCallback(
    (e: React.PointerEvent) => {
      if (!interactionRef.current) setCursor("default");
      onPointerUp(e);
    },
    [onPointerUp],
  );

  return {
    cursor,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave,
    },
  };
}
