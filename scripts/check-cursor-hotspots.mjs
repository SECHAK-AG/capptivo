/**
 * Checks declared cursor hotspot inventory and coordinates.
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
 * Vector SVGs expose enough path geometry to derive a content box and assert
 * the declared hotspot sits on it. Embedded raster SVGs are checked only for
 * normalized coordinates: This script does not decode their pixels or claim
 * to validate their artwork bounds.
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
const zoomMotionSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "engine",
  "zoomMotion.ts",
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
 * loosen the box. Embedded rasters return null because their pixels are not
 * decoded here.
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
  if (points.length === 0) {
    if (/<image\b/.test(svg)) return null;
    throw new Error("no path geometry parsed");
  }

  return {
    minX: Math.min(...points.map((p) => p[0])) / vbW,
    maxX: Math.max(...points.map((p) => p[0])) / vbW,
    minY: Math.min(...points.map((p) => p[1])) / vbH,
    maxY: Math.max(...points.map((p) => p[1])) / vbH,
  };
}

function expectedCursorShapes() {
  const src = readFileSync(zoomMotionSrc, "utf8");
  const ids = src.match(/CURSOR_SHAPE_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!ids) {
    throw new Error("could not find CURSOR_SHAPE_IDS in zoomMotion.ts");
  }
  const shapes = [];
  for (const line of ids[1].split(/\r?\n/)) {
    const entry = line.match(/^\s*"([\w-]+)",?\s*$/);
    if (entry) {
      shapes.push(entry[1]);
      continue;
    }
    if (line.trim() && !line.trimStart().startsWith("//")) {
      throw new Error(`unrecognized CURSOR_SHAPE_IDS entry: ${line.trim()}`);
    }
  }
  if (shapes.length === 0 || new Set(shapes).size !== shapes.length) {
    throw new Error("CURSOR_SHAPE_IDS is empty or contains duplicates");
  }
  return shapes;
}

/** Parse the anchor tables out of cursorOverlay.ts so they cannot drift apart. */
function parseDeclaredHotspots(src, expectedShapes) {
  // shape id → filename (shared across theme packs).
  const filesIdx = src.indexOf("const CURSOR_SHAPE_FILES");
  if (filesIdx < 0)
    throw new Error("could not find CURSOR_SHAPE_FILES in cursorOverlay.ts");
  const filesEnd = src.indexOf("};", filesIdx);
  if (filesEnd < 0) {
    throw new Error("could not find the end of CURSOR_SHAPE_FILES");
  }
  const filesStart = src.indexOf("= {", filesIdx);
  if (filesStart < 0 || filesStart > filesEnd) {
    throw new Error("could not find the start of CURSOR_SHAPE_FILES");
  }
  const filesBody = src.slice(filesStart + 3, filesEnd);
  const shapeFiles = {};
  for (const line of filesBody.split(/\r?\n/)) {
    const entry = line.match(/^\s+"?([\w-]+)"?:\s*"([\w.-]+\.svg)",?\s*$/);
    if (!entry) {
      if (line.trim() && !line.trimStart().startsWith("//")) {
        throw new Error(`unrecognized CURSOR_SHAPE_FILES entry: ${line.trim()}`);
      }
      continue;
    }
    if (Object.hasOwn(shapeFiles, entry[1])) {
      throw new Error(`CURSOR_SHAPE_FILES.${entry[1]} is declared more than once`);
    }
    shapeFiles[entry[1]] = entry[2];
  }
  for (const shape of expectedShapes) {
    if (!Object.hasOwn(shapeFiles, shape)) {
      throw new Error(`CURSOR_SHAPE_FILES.${shape} was not parsed`);
    }
  }
  for (const shape of Object.keys(shapeFiles)) {
    if (!expectedShapes.includes(shape)) {
      throw new Error(`CURSOR_SHAPE_FILES.${shape} is not a known cursor shape`);
    }
  }

  const cursorTheme = src.match(/type CursorTheme\s*=([\s\S]*?);/);
  if (!cursorTheme) {
    throw new Error("could not find CursorTheme in cursorOverlay.ts");
  }
  const expectedThemes = [
    ...cursorTheme[1].matchAll(/"([\w-]+)"/g),
  ].map((match) => match[1]);
  if (expectedThemes.length === 0) {
    throw new Error("CursorTheme parse came up empty — parser drift?");
  }
  if (new Set(expectedThemes).size !== expectedThemes.length) {
    throw new Error("CursorTheme contains a duplicate theme");
  }

  // theme → shape → hotspot, flattened to `theme/file` → hotspot.
  const hotspotsIdx = src.indexOf("const THEME_HOTSPOTS");
  if (hotspotsIdx < 0)
    throw new Error("could not find THEME_HOTSPOTS in cursorOverlay.ts");
  const hotspotsEnd = src.indexOf("\n};", hotspotsIdx);
  if (hotspotsEnd < 0) {
    throw new Error("could not find the end of THEME_HOTSPOTS");
  }
  const hotspotsStart = src.indexOf("= {", hotspotsIdx);
  if (hotspotsStart < 0 || hotspotsStart > hotspotsEnd) {
    throw new Error("could not find the start of THEME_HOTSPOTS");
  }
  const hotspotsBody = src.slice(hotspotsStart + 3, hotspotsEnd);
  const hotspots = {};
  const themeEntries = {};
  let theme = null;
  for (const line of hotspotsBody.split(/\r?\n/)) {
    const themeMatch = line.match(/^  "?([\w-]+)"?: \{$/);
    if (themeMatch) {
      theme = themeMatch[1];
      if (!expectedThemes.includes(theme)) {
        throw new Error(`unexpected hotspot theme: ${theme}`);
      }
      if (Object.hasOwn(themeEntries, theme)) {
        throw new Error(`${theme} hotspot theme is declared more than once`);
      }
      themeEntries[theme] = {};
      continue;
    }
    const entry = line.match(
      /^    "?([\w-]+)"?:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)\s*\},?\s*$/,
    );
    if (!entry) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "}," && !trimmed.startsWith("//")) {
        throw new Error(`unrecognized hotspot entry: ${trimmed}`);
      }
      continue;
    }
    if (theme) {
      if (!Object.hasOwn(shapeFiles, entry[1])) {
        throw new Error(`${theme}.${entry[1]} is not a known cursor shape`);
      }
      if (Object.hasOwn(themeEntries[theme], entry[1])) {
        throw new Error(`${theme}.${entry[1]} is declared more than once`);
      }
      const hotspot = {
        x: Number(entry[2]),
        y: Number(entry[3]),
      };
      themeEntries[theme][entry[1]] = hotspot;
      hotspots[`${theme}/${shapeFiles[entry[1]]}`] = hotspot;
    }
  }

  for (const expectedTheme of expectedThemes) {
    if (!Object.hasOwn(themeEntries, expectedTheme)) {
      throw new Error(`${expectedTheme} hotspot theme was not parsed`);
    }
    for (const shape of expectedShapes) {
      if (!Object.hasOwn(themeEntries[expectedTheme], shape)) {
        throw new Error(`${expectedTheme}.${shape} hotspot was not parsed`);
      }
    }
  }

  const figmaMatches = [
    ...src.matchAll(
      /FIGMA_ARROW = \{ url: "\/cursors\/([\w.-]+)", x: ([\d.]+), y: ([\d.]+) \}/g,
    ),
  ];
  if (figmaMatches.length !== 1)
    throw new Error("could not find FIGMA_ARROW in cursorOverlay.ts");
  const figma = figmaMatches[0];
  hotspots[figma[1]] = { x: Number(figma[2]), y: Number(figma[3]) };

  const expectedCount = expectedThemes.length * expectedShapes.length + 1;
  if (Object.keys(hotspots).length !== expectedCount) {
    throw new Error(
      `parsed ${Object.keys(hotspots).length} hotspots, expected ${expectedCount}`,
    );
  }

  return hotspots;
}

/** Read the real source and prove the parser gives LF and CRLF identical results. */
function declaredHotspots() {
  const src = readFileSync(overlaySrc, "utf8");
  const expectedShapes = expectedCursorShapes();
  const lf = src.replace(/\r\n/g, "\n");
  const fromLf = parseDeclaredHotspots(lf, expectedShapes);
  const fromCrlf = parseDeclaredHotspots(
    lf.replace(/\n/g, "\r\n"),
    expectedShapes,
  );

  if (JSON.stringify(fromLf) !== JSON.stringify(fromCrlf)) {
    throw new Error("cursor hotspot parsing differs between LF and CRLF");
  }

  return parseDeclaredHotspots(src, expectedShapes);
}

// Curves bow outside the on-path hull, and a hotspot legitimately sits a hair
// outside the box at a rounded tip. Anything past this is real drift.
const TOLERANCE = 0.06;
/** Arrow glyphs point up-left, so their hotspot belongs in the tip quadrant. */
const ARROWS = new Set(["tahoe/arrow.svg", "minimal.svg", "macos/arrow.svg"]);

const hotspots = declaredHotspots();
const names = Object.keys(hotspots);

for (const [file, hotspot] of Object.entries(hotspots)) {
  const normalized = assert(
    Number.isFinite(hotspot.x) &&
      Number.isFinite(hotspot.y) &&
      hotspot.x >= 0 &&
      hotspot.x <= 1 &&
      hotspot.y >= 0 &&
      hotspot.y <= 1,
    `${file}: hotspot (${hotspot.x}, ${hotspot.y}) is outside the normalized viewBox`,
  );
  if (!normalized) continue;

  let box;
  try {
    box = contentBox(file);
  } catch (err) {
    assert(false, `${file}: ${err.message}`);
    continue;
  }
  if (box === null) {
    console.warn(`… ${file}: embedded raster has no path geometry (bounds only)`);
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
