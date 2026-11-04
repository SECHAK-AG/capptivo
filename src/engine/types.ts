import type { BlurRegion } from "./blurRegions";
import type { CaptionCue, CaptionSettings } from "../captions/types";
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
  recordingScale?: number;
  recordingOffsetX?: number;
  recordingOffsetY?: number;
  blurRegions?: BlurRegion[];
  selectedBlurRegionId?: string | null;
  captions?: CaptionCue[];
  captionSettings?: CaptionSettings;
  selectedCaptionId?: string | null;
  segments: TrimSegment[];
  zoomFragments: ZoomFragment[];
  selectedSegmentId: string | null;
  selectedZoomFragmentId: string | null;
  currentTime: number;
};
