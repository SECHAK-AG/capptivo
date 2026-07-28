/**
 * Runnable check for AAC priming timestamp clamp. Run:
 *   node --experimental-strip-types src/windows/editor/export/exportAudioTimestamps.selfcheck.ts
 *
 * Mediabunny demux yields negative PTS for AAC encoder delay (~−1024/48000s);
 * the muxer rejects them. `forMuxTimestamp` drops pure priming and clips
 * straddling packets to t≥0.
 */

import { EncodedPacket } from "mediabunny";
import { forMuxTimestamp } from "./exportAudioTimestamps.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const priming = -1024 / 48000; // ≈ −0.021333… — the error the user hit
const frame = 1024 / 48000;

const skip = forMuxTimestamp(
  new EncodedPacket(new Uint8Array([1]), "key", priming, frame),
);
assert(skip === null, "full priming packet (end≤0) must be dropped");

const straddle = forMuxTimestamp(
  new EncodedPacket(new Uint8Array([1]), "key", priming, frame * 2),
);
assert(straddle !== null, "packet straddling 0 must be kept");
assert(straddle!.timestamp === 0, "straddle starts at 0");
assert(
  Math.abs(straddle!.duration - (priming + frame * 2)) < 1e-12,
  "straddle duration is the audible tail",
);

const ok = forMuxTimestamp(new EncodedPacket(new Uint8Array([1]), "key", 0, frame));
assert(ok !== null && ok.timestamp === 0, "t=0 packet passes through");

const later = forMuxTimestamp(
  new EncodedPacket(new Uint8Array([1]), "key", 1.5, frame),
);
assert(later !== null && later.timestamp === 1.5, "positive packet unchanged");

console.log("exportAudioTimestamps.selfcheck: ok");
