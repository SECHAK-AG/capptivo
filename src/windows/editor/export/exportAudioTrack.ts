/**
 * Packet-copy a prepared audio sidecar into the export container during the
 * video encode, so we never rewrite the finished file with FFmpeg attach.
 *
 * Packets are copied without decoding or re-encoding — same guarantee as
 * FFmpeg `-c copy`. Any failure returns `null` so the caller falls back to the
 * classic attach pass (same escape-hatch shape as `openSequentialMedia`).
 */

import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";

import { forMuxTimestamp } from "./exportAudioTimestamps";
import { rangedMediaSource } from "./sequentialMedia";

export type ExportAudioTrack = {
  /** The source to hand `output.addAudioTrack()` before `output.start()`. */
  source: EncodedAudioPacketSource;
  /** Pump every packet in decode order. Call after `output.start()`. */
  pump: () => Promise<void>;
  dispose: () => void;
};

/**
 * Open a prepared audio sidecar for direct packet copy into the export
 * container. Returns `null` on any failure so the caller falls back to the
 * FFmpeg attach pass — the same escape-hatch shape `openSequentialMedia` uses.
 */
export async function openExportAudioTrack(
  mediaUrl: string,
): Promise<ExportAudioTrack | null> {
  let input: Input | null = null;
  try {
    input = new Input({
      source: rangedMediaSource(mediaUrl),
      formats: ALL_FORMATS,
    });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      input.dispose();
      return null;
    }
    const codec = await track.getCodec();
    if (!codec) {
      input.dispose();
      return null;
    }

    const source = new EncodedAudioPacketSource(codec);
    const decoderConfig = await track.getDecoderConfig();
    const meta = decoderConfig ? { decoderConfig } : undefined;
    const packets = new EncodedPacketSink(track);

    const owned = input;
    input = null; // ownership transferred to the returned handle

    let first = true;
    return {
      source,
      pump: async () => {
        for await (const packet of packets.packets()) {
          // AAC priming is ~−1024/48000s; muxer rejects negative PTS.
          const adjusted = forMuxTimestamp(packet);
          if (!adjusted) continue;
          await source.add(adjusted, first ? meta : undefined);
          first = false;
        }
      },
      dispose: () => {
        owned.dispose();
      },
    };
  } catch (e) {
    console.warn("export audio track open failed; will fall back to post-mux", e);
    input?.dispose();
    return null;
  }
}
