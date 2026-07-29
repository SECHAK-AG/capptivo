/** Selfcheck: screen preview URL prefers proxy. */
import { screenPreviewUrl } from "./screenPreviewUrl.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(
  screenPreviewUrl("media://proxy", "media://screen") === "media://proxy",
  "proxy wins when present",
);
assert(
  screenPreviewUrl(null, "media://screen") === "media://screen",
  "falls back to original",
);
assert(screenPreviewUrl(null, null) === null, "both missing → null");

console.log("screenPreviewUrl.selfcheck: ok");
