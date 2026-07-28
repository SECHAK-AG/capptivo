/**
 * Same-origin media URLs for GPU compositing.
 * `media://` is cross-origin on WKWebView; assembled via bounded Range reads.
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

/**
 * Above this, wait for the preview proxy instead of copying the original into JS heap.
 */
export const MEDIA_DIRECT_PREVIEW_LIMIT = 256 * 1024 * 1024;

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
      parts = [probe.body];
      concurrency = 1;
      break;
    case "ranged":
      parts = await readWindowsConcurrently(url, probe.total, signal);
      concurrency = Math.min(MEDIA_FETCH_CONCURRENCY, parts.length);
      break;
    case "unknown":
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

type MediaProbe =
  | { kind: "whole"; contentType: string; body: ArrayBuffer }
  | { kind: "ranged"; contentType: string; total: number }
  | { kind: "unknown"; contentType: string };

/** Probe size via one-byte ranged read (`Content-Range` from Rust handler). */
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

/** Byte size without materializing; `null` when server reports no total. */
export async function probeMediaSize(
  url: string,
  options: ToBlobMediaUrlOptions = {},
): Promise<number | null> {
  const probe = await probeMedia(url, options.signal);
  switch (probe.kind) {
    case "whole":
      return probe.body.byteLength;
    case "ranged":
      return probe.total;
    case "unknown":
      return null;
  }
}

/** Read `total` bytes as fixed windows, `MEDIA_FETCH_CONCURRENCY` at a time. */
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

/** Fallback when server does not report a total — serial window walk. */
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
