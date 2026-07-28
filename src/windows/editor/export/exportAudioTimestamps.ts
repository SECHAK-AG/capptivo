/**
 * AAC/Opus packets from a demuxer may carry negative PTS (encoder priming).
 * Mediabunny's muxer requires non-negative timestamps — see EncodedPacket docs:
 * "Samples with negative end timestamps should not be presented."
 */

import type { EncodedPacket } from "mediabunny";

/**
 * Drop pure priming packets; clip packets that straddle t=0 so the muxer
 * accepts them without shifting the audible timeline (keeps A/V sync).
 */
export function forMuxTimestamp(packet: EncodedPacket): EncodedPacket | null {
  const end = packet.timestamp + packet.duration;
  if (end <= 0) return null;
  if (packet.timestamp >= 0) return packet;
  return packet.clone({ timestamp: 0, duration: end });
}
