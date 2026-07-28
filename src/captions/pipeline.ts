import { parseSrtCues, parseWhisperJsonCues } from "./parser";
import { segmentCuesIntoPhrases } from "./segment";
import type { CaptionCue, SilenceInterval } from "./types";

export interface WhisperArtifacts {
  srt: string;
  json: string | null;
  silences: SilenceInterval[];
}

/** Turn whisper.cpp output into phrase-sized caption cues. */
export function buildCaptionsFromWhisper(artifacts: WhisperArtifacts): CaptionCue[] {
  const timed =
    artifacts.json && artifacts.json.trim()
      ? parseWhisperJsonCues(artifacts.json)
      : [];
  const raw =
    timed.length > 0 ? timed : parseSrtCues(artifacts.srt);
  if (raw.length === 0) return [];

  const silences = artifacts.silences.map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs >= Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : s.endMs,
  }));

  try {
    return segmentCuesIntoPhrases(raw, silences);
  } catch {
    return raw;
  }
}
