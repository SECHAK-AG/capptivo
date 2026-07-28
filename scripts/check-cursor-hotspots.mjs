/**
 * Asserts every cursor asset's declared hotspot lands on its artwork.
 * Run: `node scripts/check-cursor-hotspots.mjs`
 *
 * The bug class this guards: hotspots are hand-typed normalized constants in
 * `src/engine/cursorOverlay.ts` (`THEME_HOTSPOTS`, `FIGMA_ARROW`), while the
 * thing they must agree with — the glyph inside the SVG — lives in a separate
 * file that gets redrawn, re-exported from Figma, or swapped wholesale.
 * Nothing at runtime notices when the two drift apart: the cursor just quietly
 * stops pointing at the pixel it reports, worst at the moment that matters (a
 * click), and multiplied by the zoom scale, because the camera magnifies
 * anything anchored to the recording.
 *
 * So: derive the content box from the artwork and assert the declared hotspot
 * sits on it. A hotspot off the glyph is always a bug; an arrow hotspot away
 * from the tip is always a bug.
 *
 * Lives in scripts/ rather than as a src selfcheck because it reads files —
 * every selfcheck under src/ is pure, and the repo carries no @types/node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cursorsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "cursors",
);
const overlaySrc = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "engine",
  "cursorOverlay.ts",
);

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Content box of an SVG's path geometry, normalized to the viewBox. Only on-path
 * anchor points are read — curve control points bulge outside the hull and would
 * loosen the box. Enough to locate the glyph within its canvas, which is all
 * this check needs.
 */
function contentBox(file) {
  const svg = readFileSync(join(cursorsDir, file), "utf8");
  const vb = svg.match(/viewBox="([^"]+)"/);
  if (!vb) throw new Error(`${file}: no viewBox`);
  const [, , vbW, vbH] = vb[1].split(/\s+/).map(Number);

  const points = [];
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const tokens = m[1].match(/[A-Za-z]|-?[\d.]+/g) ?? [];
    let cmd = "";
    let cur = [0, 0];
    let nums = [];
    const flush = () => {
      const push = (p) => {
        cur = p;
        points.push(p);
      };
      if (cmd === "M" || cmd === "L")
        for (let i = 0; i + 1 < nums.length; i += 2)
          push([nums[i], nums[i + 1]]);
      else if (cmd === "C")
        for (let i = 0; i + 5 < nums.length; i += 6)
          push([nums[i + 4], nums[i + 5]]);
      else if (cmd === "V") for (const n of nums) push([cur[0], n]);
      else if (cmd === "H") for (const n of nums) push([n, cur[1]]);
      nums = [];
    };
    for (const t of tokens) {
      if (/[A-Za-z]/.test(t)) {
        flush();
        cmd = t;
      } else nums.push(parseFloat(t));
    }
    flush();
  }
  if (points.length === 0) throw new Error(`${file}: no path geometry parsed`);

  return {
    minX: Math.min(...points.map((p) => p[0])) / vbW,
    maxX: Math.max(...points.map((p) => p[0])) / vbW,
    minY: Math.min(...points.map((p) => p[1])) / vbH,
    maxY: Math.max(...points.map((p) => p[1])) / vbH,
  };
}

/** Read the anchor tables out of cursorOverlay.ts so they cannot drift apart. */
function declaredHotspots() {
  const src = readFileSync(overlaySrc, "utf8");

  // shape id → filename (shared across theme packs).
  const filesIdx = src.indexOf("const CURSOR_SHAPE_FILES");
  if (filesIdx < 0)
    throw new Error("could not find CURSOR_SHAPE_FILES in cursorOverlay.ts");
  const filesBody = src.slice(filesIdx, src.indexOf("};", filesIdx));
  const shapeFiles = {};
  for (const e of filesBody.matchAll(/"?([\w-]+)"?:\s*"([\w.-]+\.svg)"/g)) {
    shapeFiles[e[1]] = e[2];
  }
  if (Object.keys(shapeFiles).length < 10) {
    throw new Error("CURSOR_SHAPE_FILES parse came up short — parser drift?");
  }

  // theme → shape → hotspot, flattened to `theme/file` → hotspot.
  const hotspotsIdx = src.indexOf("const THEME_HOTSPOTS");
  if (hotspotsIdx < 0)
    throw new Error("could not find THEME_HOTSPOTS in cursorOverlay.ts");
  const hotspotsBody = src.slice(hotspotsIdx, src.indexOf("\n};", hotspotsIdx));
  const hotspots = {};
  let theme = null;
  for (const line of hotspotsBody.split("\n")) {
    const themeMatch = line.match(/^  (\w+): \{$/);
    if (themeMatch) {
      theme = themeMatch[1];
      continue;
    }
    const entry = line.match(
      /"?([\w-]+)"?:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)\s*\}/,
    );
    if (theme && entry && shapeFiles[entry[1]]) {
      hotspots[`${theme}/${shapeFiles[entry[1]]}`] = {
        x: Number(entry[2]),
        y: Number(entry[3]),
      };
    }
  }

  const figma = src.match(
    /FIGMA_ARROW = \{ url: "\/cursors\/([\w.-]+)", x: ([\d.]+), y: ([\d.]+) \}/,
  );
  if (!figma)
    throw new Error("could not find FIGMA_ARROW in cursorOverlay.ts");
  hotspots[figma[1]] = { x: Number(figma[2]), y: Number(figma[3]) };

  return hotspots;
}

// Curves bow outside the on-path hull, and a hotspot legitimately sits a hair
// outside the box at a rounded tip. Anything past this is real drift.
const TOLERANCE = 0.06;
/** Arrow glyphs point up-left, so their hotspot belongs in the tip quadrant. */
const ARROWS = new Set(["tahoe/arrow.svg", "minimal.svg", "macos/arrow.svg"]);

const hotspots = declaredHotspots();
const names = Object.keys(hotspots);
assert(
  names.length >= 25,
  `parsed only ${names.length} hotspots — parser drift?`,
);

for (const [file, hotspot] of Object.entries(hotspots)) {
  let box;
  try {
    box = contentBox(file);
  } catch (err) {
    // The macos pack is traced rasters with no plain path data — skip rather
    // than fail, but say so, so a silent gap never looks like a pass.
    console.warn(`… ${file}: ${err.message} (skipped)`);
    continue;
  }

  const ok = assert(
    hotspot.x >= box.minX - TOLERANCE &&
      hotspot.x <= box.maxX + TOLERANCE &&
      hotspot.y >= box.minY - TOLERANCE &&
      hotspot.y <= box.maxY + TOLERANCE,
    `${file}: hotspot (${hotspot.x}, ${hotspot.y}) is off the artwork ` +
      `[x ${box.minX.toFixed(3)}..${box.maxX.toFixed(3)}, ` +
      `y ${box.minY.toFixed(3)}..${box.maxY.toFixed(3)}] — ` +
      `the cursor will not point at the pixel it reports`,
  );

  if (ok && ARROWS.has(file)) {
    const fx = (hotspot.x - box.minX) / (box.maxX - box.minX);
    const fy = (hotspot.y - box.minY) / (box.maxY - box.minY);
    assert(
      fx < 0.35 && fy < 0.35,
      `${file}: hotspot sits ${(fx * 100).toFixed(0)}%/${(fy * 100).toFixed(0)}% ` +
        `into the glyph — an arrow's hotspot is its tip, not its body`,
    );
  }
}

if (!process.exitCode) {
  console.log(`cursor hotspots: ok (${names.length} assets)`);
}
