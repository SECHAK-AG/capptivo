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
 */

/** Window size for ranged reads. */
export const MEDIA_FETCH_WINDOW = 8 * 1024 * 1024;

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

  const signal = options.signal;
  const parts: ArrayBuffer[] = [];
  let contentType = "";
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
    if (!contentType) contentType = res.headers.get("Content-Type") ?? "";

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) break;
    parts.push(buf);
    start += buf.byteLength;

    // 200 = whole body at once (small file) → done.
    if (res.status !== 206) break;
    const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
    if (Number.isFinite(total) && start >= total) break;
    if (buf.byteLength < MEDIA_FETCH_WINDOW) break;
  }

  signal?.throwIfAborted();

  if (start < 64) {
    throw new Error("media is empty");
  }

  const blob = new Blob(parts, contentType ? { type: contentType } : undefined);
  console.info(
    `[media] blob assembled: ${blob.size} bytes from ${parts.length} range(s), url=${url}`,
  );
  const src = URL.createObjectURL(blob);
  return { src, revoke: () => URL.revokeObjectURL(src) };
}
