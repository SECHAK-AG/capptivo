/**
 * Background presets — ported from the web editor's `lib/editor/backgroundPresets.ts`
 * so the desktop editor offers the same image/gradient/color options. (Phase 1
 * moves this into the shared `@capptivo/editor-engine` package; kept local for
 * the foundation.)
 */

export type BackgroundType = "image" | "gradient" | "color";

export interface BackgroundPreset {
  id: string;
  label: string;
  type: BackgroundType;
  /** The renderable source: a URL (image), or a data-URL (gradient/color). */
  src: string;
  /** CSS used for the swatch preview in the panel. */
  previewCss: string;
}

export interface GradientStop {
  offset: number;
  color: string;
}

export interface GradientDefinition {
  id: string;
  label: string;
  angle: number;
  stops: GradientStop[];
}

export const BACKGROUND_IMAGE_FILES = [
  "image-2.webp",
  "image-3.webp",
  "image-4.jpg",
  "image-5.webp",
  "monterey-stock.webp",
  "monterey.webp",
  "ventura-1.webp",
  "ventura-2.webp",
  "image-6.webp",
  "image-7.webp",
  "image-8.jpg",
  "image-10.jpg",
  "image-11.jpg",
  "sonoma-clouds.jpg",
  "sonoma-dark.jpg",
  "sonoma-horizon.jpg",
  "sonoma-light.jpg",
] as const;

export const BACKGROUND_GRADIENTS: GradientDefinition[] = [
  {
    id: "g-aurora-43",
    label: "Aurora 43",
    angle: 43,
    stops: [
      { offset: 0, color: "#4158D0" },
      { offset: 46, color: "#C850C0" },
      { offset: 100, color: "#FFCC70" },
    ],
  },
  {
    id: "g-violet-sky",
    label: "Violet Sky",
    angle: 135,
    stops: [
      { offset: 0, color: "rgb(139, 198, 236)" },
      { offset: 100, color: "rgb(149, 153, 226)" },
    ],
  },
  {
    id: "g-pool-dream",
    label: "Pool Dream",
    angle: 120,
    stops: [
      { offset: 0, color: "#0EA5E9" },
      { offset: 50, color: "#22D3EE" },
      { offset: 100, color: "#A78BFA" },
    ],
  },
  {
    id: "g-peach-flare",
    label: "Peach Flare",
    angle: 160,
    stops: [
      { offset: 0, color: "#FB7185" },
      { offset: 100, color: "#F59E0B" },
    ],
  },
  {
    id: "g-mint-leaf",
    label: "Mint Leaf",
    angle: 62,
    stops: [
      { offset: 0, color: "rgb(142, 197, 252)" },
      { offset: 100, color: "rgb(224, 195, 252)" },
    ],
  },
  {
    id: "g-midnight-ocean",
    label: "Midnight Ocean",
    angle: 130,
    stops: [
      { offset: 0, color: "#0F172A" },
      { offset: 55, color: "#1D4ED8" },
      { offset: 100, color: "#22D3EE" },
    ],
  },
  {
    id: "g-sunrise-haze",
    label: "Sunrise Haze",
    angle: 80,
    stops: [
      { offset: 0, color: "#FEF3C7" },
      { offset: 45, color: "#FDBA74" },
      { offset: 100, color: "#FB7185" },
    ],
  },
  {
    id: "g-neon-night",
    label: "Neon Night",
    angle: 210,
    stops: [
      { offset: 0, color: "#0B1026" },
      { offset: 50, color: "#1E3A8A" },
      { offset: 100, color: "#9333EA" },
    ],
  },
  {
    id: "g-forest-glow",
    label: "Forest Glow",
    angle: 70,
    stops: [
      { offset: 0, color: "#4ADE80" },
      { offset: 35, color: "#22C55E" },
      { offset: 100, color: "#065F46" },
    ],
  },
  {
    id: "g-pastel-bloom",
    label: "Pastel Bloom",
    angle: 35,
    stops: [
      { offset: 0, color: "#FDE68A" },
      { offset: 50, color: "#FCA5A5" },
      { offset: 100, color: "#C4B5FD" },
    ],
  },
  {
    id: "g-slate-wave",
    label: "Slate Wave",
    angle: 190,
    stops: [
      { offset: 0, color: "#1F2937" },
      { offset: 100, color: "#4B5563" },
    ],
  },
];

export const BACKGROUND_COLORS = [
  "#22C55E",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#A855F7",
  "#F43F5E",
  "#FB923C",
  "#FACC15",
  "#A3E635",
  "#E5E7EB",
];

export const BACKGROUND_TYPE_TABS: { id: BackgroundType; label: string }[] = [
  { id: "image", label: "Image" },
  { id: "gradient", label: "Gradient" },
  { id: "color", label: "Color" },
];

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, value));

export const clampGradientAngle = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(360, Math.round(value))) : 135;

export const isHexColor = (value: string): boolean =>
  /^#[0-9A-Fa-f]{6}$/.test(value.trim());

export const gradientToCss = (definition: GradientDefinition): string => {
  const stops = definition.stops
    .map((stop) => `${stop.color} ${clampPercent(stop.offset)}%`)
    .join(", ");
  return `linear-gradient(${definition.angle}deg, ${stops})`;
};

/** Rasterize a gradient to a PNG data-URL (used as the render source). */
export const gradientToDataUrl = (
  definition: GradientDefinition,
  width = 1920,
  height = 1080,
): string => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const radians = ((definition.angle - 90) * Math.PI) / 180;
  const half = Math.sqrt(width * width + height * height) / 2;
  const [cx, cy] = [width / 2, height / 2];
  const [dx, dy] = [Math.cos(radians) * half, Math.sin(radians) * half];
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  definition.stops.forEach((stop) =>
    gradient.addColorStop(clampPercent(stop.offset) / 100, stop.color),
  );

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
};

export const colorToDataUrl = (
  color: string,
  width = 1920,
  height = 1080,
): string => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
};

const toBackgroundLabel = (fileName: string): string =>
  fileName
    .replace(/\.[^.]+$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export function buildImageBackgroundPresets(): BackgroundPreset[] {
  return BACKGROUND_IMAGE_FILES.map((fileName) => ({
    id: `img-${fileName}`,
    label: toBackgroundLabel(fileName),
    type: "image",
    src: `/background-images/${fileName}`,
    previewCss: `url(/background-images/${fileName})`,
  }));
}

export function buildGradientBackgroundPresets(): BackgroundPreset[] {
  return BACKGROUND_GRADIENTS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    type: "gradient",
    src: gradientToDataUrl(definition),
    previewCss: gradientToCss(definition),
  }));
}

export function buildColorBackgroundPresets(): BackgroundPreset[] {
  return BACKGROUND_COLORS.map((color, index) => ({
    id: `bg-color-${index}`,
    label: color,
    type: "color",
    src: colorToDataUrl(color),
    previewCss: color,
  }));
}
