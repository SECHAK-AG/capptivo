/**
 * Why an export could not decode linearly — in words that survive the trip to a
 * user's disk log.
 *
 * Linear decode walks the file once and spends one decode per output frame. The
 * fallback sets `<video>.currentTime` per frame, and a seek must decode forward
 * from the preceding keyframe. The recorder sets no explicit GOP, so the
 * encoder's default (~250 frames) applies: up to ~250 decodes to produce one
 * output frame. That is the shape of a 60× slowdown, and until this module
 * existed it happened inside a swallowed `catch` with nothing in any log.
 *
 * Kept free of imports so `decodeFallback.selfcheck.ts` can run it under Node.
 */

export type DecodeFallbackCode =
  | "no-decoder"
  | "no-video-track"
  | "undecodable"
  | "open-failed";

/**
 * Longest failure detail we will put in a log line. Demuxer messages can carry
 * a whole stack; the log is a rolling file on a user's disk, and one export can
 * append several of these. Truncation counts `char`s so a multi-byte sequence
 * is never split.
 */
export const DETAIL_CAP = 200;

const FIXED_REASON: Record<Exclude<DecodeFallbackCode, "open-failed">, string> = {
  "no-decoder": "WebCodecs VideoDecoder is unavailable in this WebView",
  "no-video-track": "the recording has no primary video track",
  "undecodable": "this WebView cannot decode the recording's video codec",
};

/** Collapse a failure detail to one bounded, single-line fragment. */
export function trimDetail(raw: string): string {
  const flat = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("; ");
  if (flat.length === 0) return "no detail";
  if (flat.length <= DETAIL_CAP) return flat;
  return `${flat.slice(0, DETAIL_CAP)}…`;
}

/** Short reason phrase naming what went wrong. */
export function decodeFallbackReason(
  code: DecodeFallbackCode,
  detail = "",
): string {
  if (code === "open-failed") return `demux failed: ${trimDetail(detail)}`;
  return FIXED_REASON[code];
}

/**
 * The full operator-facing sentence. Says the reason *and* the consequence —
 * whoever reads this log line is usually asking "why is the export slow", and
 * the reason alone does not answer that.
 */
export function decodeFallbackMessage(route: string, reason: string): string {
  return (
    `${route}: sequential decode unavailable (${reason}) — falling back to ` +
    `per-frame seeks, which decode from the preceding keyframe and are far slower`
  );
}
