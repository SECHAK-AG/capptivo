/**
 * Progress reporting for the export loops.
 *
 * Progress writes go through the editor store, which re-renders the export UI.
 * At 60fps over a few minutes that is tens of thousands of React renders
 * competing with the encode loop for the main thread, to move a bar that is
 * measured in whole percent. Report only when the rounded percentage actually
 * changes.
 *
 * Shared because all three render loops need exactly this and had each grown
 * their own copy.
 */

import { useEditorStore } from "../store";

export function throttledProgress(
  totalFrames: number,
): (framesDone: number) => void {
  let lastPercent = -1;
  return (framesDone) => {
    const ratio = Math.min(1, framesDone / Math.max(1, totalFrames));
    const percent = Math.round(ratio * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    useEditorStore.getState().setExportProgress(ratio);
  };
}
