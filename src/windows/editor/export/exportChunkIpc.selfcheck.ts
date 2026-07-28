/** Selfcheck: export-chunk IPC uses raw bytes, not JSON. */

export {}; // module scope — keeps top-level helpers out of the global namespace

/** Byte-for-byte port of Tauri 2.11's `processIpcMessage`. */
function tauriContentType(message: unknown): "octet-stream" | "json" {
  if (
    message instanceof ArrayBuffer ||
    ArrayBuffer.isView(message) ||
    Array.isArray(message)
  ) {
    return "octet-stream";
  }
  return "json";
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const chunk = new Uint8Array([1, 2, 3, 4]);

// What we send now: the chunk IS the payload.
assert(tauriContentType(chunk) === "octet-stream", "raw chunk payload must be octet-stream");

// What we used to send: scalars and bytes in one object → JSON.
assert(
  tauriContentType({ handle: 1, position: 0, chunk }) === "json",
  "object payload is JSON — this is the bug this check guards against",
);

// And the JSON path really does expand each byte to a decimal number.
const encoded = JSON.stringify({ chunk }, (_k, val) =>
  val instanceof Uint8Array ? Array.from(val) : val,
);
assert(encoded === '{"chunk":[1,2,3,4]}', `unexpected JSON encoding: ${encoded}`);

// Camera/mic chunks are append-only: the bare Uint8Array is the whole payload,
// with no headers at all. Same rule, simpler shape.
assert(
  tauriContentType(new Uint8Array([9, 9])) === "octet-stream",
  "bare camera/mic chunk payload must be octet-stream",
);

console.log("exportChunkIpc.selfcheck: ok");
