export type Point = { x: number; y: number };

export type AnnotationTool =
  | "select"
  | "pen"
  | "highlighter"
  | "laser"
  | "eraser"
  | "shape"
  | "text";

export type EraserMode = "stroke" | "pixel";

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";

export type PathItem = {
  kind: "path";
  points: Point[];
  color: string;
  width: number;
  highlighter: boolean;
};

export type ShapeItem = {
  kind: "shape";
  shape: ShapeKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
};

export type TextItem = {
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
};

export type PixelEraseItem = {
  kind: "pixelErase";
  points: Point[];
  radius: number;
};

export type HistoryItem =
  | PathItem
  | ShapeItem
  | TextItem
  | PixelEraseItem;
