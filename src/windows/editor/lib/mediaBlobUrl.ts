/**
 * Same-origin media URLs for GPU compositing.
 *
 * WKWebView treats `media://` as cross-origin even with CORS headers, so
 * WebGL `texImage2D` and WebGPU `copyExternalImageToTexture` both throw
 * SecurityError when uploading `<video>` frames. Same-origin `blob:` URLs
 * work (already used for export).
 *
 * Assembled from bounded Range reads so the Rust `media://` handler never
 * holds a multi-GB file in one `Vec` (see media_protocol.rs).
 *
 * Those reads run **concurrently**. Each window is a full Tauri IPC round-trip
 * (disk read on the Rust side, response copied into the WebView), so reading
 * them one at a time left both the disk and the IPC channel idle waiting on
 * latency rather than bandwidth — and nothing can paint until the last one
 * lands. Windows are written back by index, never appended, so completion
 * order cannot affect the assembled bytes.
 */

/** Window size for ranged reads. */
export const MEDIA_FETCH_WINDOW = 8 * 1024 * 1024;

/**
 * Windows in flight at once. Four keeps the pipe full without letting peak
 * in-flight memory grow past ~32 MiB on top of the parts already assembled.
 */
export const MEDIA_FETCH_CONCURRENCY = 4;

/** Smaller than this is not a decodable container — treat it as an empty read. */
const MIN_MEDIA_BYTES = 64;

export type BlobMediaUrl = {
  src: string;
  revoke: () => void;
};

export type ToBlobMediaUrlOptions = {
  /** Abort in-flight ranged reads (e.g. proxy swapped in before screen finished). */
  signal?: AbortSignal;
};

/** True when the URL is already same-origin for GPU upload. */
export function isSameOriginMediaUrl(url: string): boolean {
  return url.startsWith("blob:") || url.startsWith("data:");
}

/**
 * Resolve a media URL to a same-origin blob URL. Pass-through for blob:/data:.
 * Caller must `revoke()` when done (no-op for pass-through).
 */
export async function toBlobMediaUrl(
  url: string,
  options: ToBlobMediaUrlOptions = {},
): Promise<BlobMediaUrl> {
  if (isSameOriginMediaUrl(url)) {
    return { src: url, revoke: () => undefined };
  }

  const { signal } = options;
  const probe = await probeMedia(url, signal);

  let parts: ArrayBuffer[];
  let concurrency: number;
  switch (probe.kind) {
    case "whole":
      // Server answered the probe with the entire body — nothing left to read.
      parts = [probe.body];
      concurrency = 1;
      break;
    case "ranged":
      parts = await readWindowsConcurrently(url, probe.total, signal);
      concurrency = Math.min(MEDIA_FETCH_CONCURRENCY, parts.length);
      break;
    case "unknown":
      // No total to plan windows from; walk them until EOF as we always did.
      parts = await readSequentially(url, signal);
      concurrency = 1;
      break;
  }

  signal?.throwIfAborted();

  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  if (size < MIN_MEDIA_BYTES) {
    throw new Error("media is empty");
  }

  const blob = new Blob(
    parts,
    probe.contentType ? { type: probe.contentType } : undefined,
  );
  console.info(
    `[media] blob assembled: ${blob.size} bytes from ${parts.length} range(s) ` +
      `concurrency=${concurrency}, url=${url}`,
  );
  const src = URL.createObjectURL(blob);
  return { src, revoke: () => URL.revokeObjectURL(src) };
}

/**
 * What a one-byte probe told us about the resource.
 *
 * `ranged` is the path every real `media://` response takes; the other two
 * exist so a server that answers a Range with the whole body, or without a
 * `Content-Range`, still loads rather than failing.
 */
type MediaProbe =
  | { kind: "whole"; contentType: string; body: ArrayBuffer }
  | { kind: "ranged"; contentType: string; total: number }
  | { kind: "unknown"; contentType: string };

/**
 * Learn the resource's size from a single one-byte ranged read, so the windows
 * can be planned up front and issued in parallel instead of discovered one at a
 * time. `src-tauri/src/media_protocol.rs` exposes `Content-Range` via
 * `Access-Control-Expose-Headers`, which is what makes this readable here.
 */
async function probeMedia(
  url: string,
  signal: AbortSignal | undefined,
): Promise<MediaProbe> {
  signal?.throwIfAborted();
  const res = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    signal,
  });

  // The handler answers 416 when the file has no bytes to give.
  if (res.status === 416) throw new Error("media is empty");
  if (!res.ok) throw new Error(`failed to load media (${res.status})`);

  const contentType = res.headers.get("Content-Type") ?? "";
  if (res.status !== 206) {
    return { kind: "whole", contentType, body: await res.arrayBuffer() };
  }

  const total = totalFromContentRange(res);
  // Drain the one-byte body so the response is not left half-read.
  await res.arrayBuffer();
  return total === null
    ? { kind: "unknown", contentType }
    : { kind: "ranged", contentType, total };
}

/** Total size from `Content-Range: bytes S-E/TOTAL`, or null when unusable. */
function totalFromContentRange(res: Response): number | null {
  const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Read `total` bytes as fixed windows, `MEDIA_FETCH_CONCURRENCY` at a time.
 *
 * Workers pull the next un-started window from a shared cursor and write it to
 * its own slot, so a window that lands early never displaces one that lands
 * late. The byte-count check at the end is what turns a short or dropped
 * response into a loud failure instead of a subtly truncated recording.
 */
async function readWindowsConcurrently(
  url: string,
  total: number,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer[]> {
  const count = Math.ceil(total / MEDIA_FETCH_WINDOW);
  const parts = new Array<ArrayBuffer | undefined>(count);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      signal?.throwIfAborted();
      const index = cursor++;
      if (index >= count) return;

      const start = index * MEDIA_FETCH_WINDOW;
      const end = Math.min(total, start + MEDIA_FETCH_WINDOW) - 1;
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      });
      if (!res.ok) throw new Error(`failed to load media (${res.status})`);
      parts[index] = await res.arrayBuffer();
    }
  };

  const workers = Math.min(MEDIA_FETCH_CONCURRENCY, count);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  let read = 0;
  for (const part of parts) {
    if (part === undefined) {
      throw new Error(`media read incomplete (missing window of ${count})`);
    }
    read += part.byteLength;
  }
  if (read !== total) {
    throw new Error(`media read incomplete (${read}/${total} bytes)`);
  }
  return parts as ArrayBuffer[];
}

/**
 * Fallback for a server that does not report a total: walk windows forward
 * until one comes back short or unsatisfiable. Serial by necessity — without a
 * size there is no next offset to request until the current window has landed.
 */
async function readSequentially(
  url: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer[]> {
  const parts: ArrayBuffer[] = [];
  let start = 0;

  for (;;) {
    signal?.throwIfAborted();
    const end = start + MEDIA_FETCH_WINDOW - 1;
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal,
    });
    // 416 = past EOF (unsatisfiable range) → done.
    if (res.status === 416) break;
    if (!res.ok) {
      throw new Error(`failed to load media (${res.status})`);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) break;
    parts.push(buf);
    start += buf.byteLength;

    // 200 = whole body at once (small file) → done.
    if (res.status !== 206) break;
    const total = totalFromContentRange(res);
    if (total !== null && start >= total) break;
    if (buf.byteLength < MEDIA_FETCH_WINDOW) break;
  }

  return parts;
}
