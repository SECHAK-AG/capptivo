/**
 * Runnable check for same-origin media URL helpers. Run:
 *   node --experimental-strip-types src/windows/editor/lib/mediaBlobUrl.selfcheck.ts
 */

import { isSameOriginMediaUrl, toBlobMediaUrl } from "./mediaBlobUrl.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isSameOriginMediaUrl("blob:http://localhost/abc"), "blob: is same-origin");
assert(isSameOriginMediaUrl("data:video/mp4;base64,xx"), "data: is same-origin");
assert(!isSameOriginMediaUrl("media://localhost/p/screen.mp4"), "media:// is cross-origin");
assert(!isSameOriginMediaUrl("http://media.localhost/p/screen.mp4"), "media host is cross-origin");

{
  const pass = await toBlobMediaUrl("blob:already-same");
  assert(pass.src === "blob:already-same", "blob passthrough keeps src");
  pass.revoke(); // no-op
}

console.log("mediaBlobUrl.selfcheck: ok");
