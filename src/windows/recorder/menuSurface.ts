/**
 * Setup chrome lives in a work-area overlay. The native window never resizes
 * for drag or menus — the pill moves with CSS, and Radix flips popovers inside
 * the overlay. That is what keeps grip click/unclick flicker-free.
 */

import { create } from "zustand";
import { commands } from "../../ipc/bindings";

/** Gap between the bar and a popover — mirrors Radix `sideOffset`. */
export const MENU_SIDE_OFFSET = 6;

/** Popover is open — keep the hitbox interactive (no click-through). */
export function setMenuLive(live: boolean): void {
  void commands.setRecorderMenuLive(live);
}

interface BarDragState {
  offset: { x: number; y: number };
  setOffset: (offset: { x: number; y: number }) => void;
  resetOffset: () => void;
}

export const useBarDrag = create<BarDragState>((set) => ({
  offset: { x: 0, y: 0 },
  setOffset: (offset) => set({ offset }),
  resetOffset: () => set({ offset: { x: 0, y: 0 } }),
}));
