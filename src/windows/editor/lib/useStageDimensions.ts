/**
 * Store-connected composition stage size. Every stage consumer (preview
 * canvas, inspector previews, padding clamps) resolves through this hook —
 * and export through the same `resolveStageSize` — so a ratio change can
 * never leave two surfaces disagreeing about the canvas.
 *
 * Screen content crop is intentionally omitted: it must only change the
 * inset recording inside a fixed stage (see `resolveStageSize`).
 */

import { useEditorStore } from "../store";
import { resolveStageSize } from "./composition";

export function useStageDimensions(): { width: number; height: number } {
  const presetId = useEditorStore((s) => s.aspectRatioPresetId);
  const sourceVideoSize = useEditorStore((s) => s.sourceVideoSize);
  return resolveStageSize(presetId, sourceVideoSize);
}
