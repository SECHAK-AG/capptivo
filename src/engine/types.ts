import type { TrimSegment } from "./trimSegments";
import type { ZoomFragment } from "./zoomMotion";

export type { TrimSegment, ZoomFragment };

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PreviewInteraction =
  | {
      mode: "drag";
      element: "facecam";
      startCompX: number;
      startCompY: number;
      startElX: number;
      startElY: number;
      currentCompX: number;
      currentCompY: number;
    }
  | {
      mode: "resize";
      element: "facecam";
      handle: string;
      startCompX: number;
      startCompY: number;
      startElX: number;
      startElY: number;
      startElW: number;
      startElH: number;
      currentElX: number;
      currentElY: number;
      currentElW: number;
      currentElH: number;
    }
  | null;

export type TimelineSnapshot = {
  segments: TrimSegment[];
  zoomFragments: ZoomFragment[];
  selectedSegmentId: string | null;
  selectedZoomFragmentId: string | null;
  currentTime: number;
};
