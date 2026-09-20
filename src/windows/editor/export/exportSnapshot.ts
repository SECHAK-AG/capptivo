import type { CaptionCue } from "@/captions/types";
import type { BlurRegion, CursorSettings, RecordingMetadata, ScreenContentCropNorm, TrimSegment, ZoomFragment } from "@/engine";
import type { Project } from "../../../ipc/types";
import type { EditorStore, FaceCamParams, LookParams } from "../store";
import { useEditorStore } from "../store";
import type { AspectRatioPresetId } from "../lib/composition";
import type { BackgroundType } from "../lib/backgroundPresets";
import type { CaptionSettings } from "@/captions/types";

export type ExportSnapshot = {
  projectId: string;
  project: Project;
  screenUrl: string;
  cameraUrl: string | null;
  cameraOffsetMs: number | null;
  sourceAspect: number;
  sourceVideoSize: { width: number; height: number };
  recordingMetadata: RecordingMetadata | null;
  aspectRatioPresetId: AspectRatioPresetId;
  backgroundType: BackgroundType;
  backgroundImage: HTMLImageElement | null;
  look: LookParams;
  cursorSettings: CursorSettings;
  faceCam: FaceCamParams;
  screenContentCrop: ScreenContentCropNorm | null;
  duration: number;
  segments: TrimSegment[];
  zoomFragments: ZoomFragment[];
  blurRegions: BlurRegion[];
  captions: CaptionCue[];
  captionSettings: CaptionSettings;
};

function cloneCaption(cue: CaptionCue): CaptionCue {
  return {
    ...cue,
    words: cue.words?.map((word) => ({ ...word })),
  };
}

/** Capture all render/audio inputs once; later editor mutations cannot affect a job. */
export function captureExportSnapshot(state: EditorStore = useEditorStore.getState()): ExportSnapshot {
  if (!state.project || !state.projectId || !state.screenUrl || !state.sourceVideoSize) {
    throw new Error("export: project media is not ready");
  }
  return {
    projectId: state.projectId,
    project: {
      ...state.project,
      capture: { ...state.project.capture },
      files: { ...state.project.files },
    },
    screenUrl: state.screenUrl,
    cameraUrl: state.cameraUrl,
    cameraOffsetMs: state.cameraOffsetMs,
    sourceAspect: state.sourceAspect,
    sourceVideoSize: { ...state.sourceVideoSize },
    recordingMetadata: state.recordingMetadata,
    aspectRatioPresetId: state.aspectRatioPresetId,
    backgroundType: state.backgroundType,
    backgroundImage: state.backgroundImage,
    look: { ...state.look },
    cursorSettings: { ...state.cursorSettings },
    faceCam: {
      ...state.faceCam,
      position: state.faceCam.position ? { ...state.faceCam.position } : null,
      crop: state.faceCam.crop ? { ...state.faceCam.crop } : null,
    },
    screenContentCrop: state.screenContentCrop ? { ...state.screenContentCrop } : null,
    duration: state.duration,
    segments: state.segments.map((segment) => ({ ...segment })),
    zoomFragments: state.zoomFragments.map((fragment) => ({
      ...fragment,
      fixedRect: fragment.fixedRect ? { ...fragment.fixedRect } : undefined,
    })),
    blurRegions: state.blurRegions.map((region) => ({ ...region })),
    captions: state.captions.map(cloneCaption),
    captionSettings: { ...state.captionSettings },
  };
}
