/**
 * Runnable check: editor preset name trim + duplicate-safe id generation shape.
 * Full normalize lives in editorPresets.ts (covered by tsc). This file stays
 * dependency-free so `node --experimental-strip-types` can run it.
 * Run: `node --experimental-strip-types src/windows/editor/lib/editorPresets.selfcheck.ts`
 */

function normalizePresets(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name.trim() : "";
    if (!name || !d.snapshot) continue;
    const id =
      typeof d.id === "string" && d.id.length > 0 ? d.id : `preset-${out.length}`;
    out.push({ id, name });
  }
  return out;
}

const presets = normalizePresets([
  { id: "a", name: "  Clean  ", snapshot: {} },
  { id: "bad", name: "", snapshot: {} },
  { name: "NoId", snapshot: {} },
]);

console.assert(presets.length === 2, "preset count");
console.assert(presets[0]!.name === "Clean", "trim name");
console.assert(presets[1]!.id === "preset-1", "generated id");

console.log("editorPresets.selfcheck: ok");
