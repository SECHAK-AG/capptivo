/**
 * Runnable check for same-origin media URL helpers. Run:
 *   node --experimental-strip-types src/windows/editor/lib/mediaBlobUrl.selfcheck.ts
 *
 * The bug class this guards: windows are fetched concurrently, so a server that
 * answers them out of order must still yield byte-identical media. A reordering
 * bug here corrupts every recording the editor opens, and corrupts it *quietly*
 * — the container still parses, the picture just falls apart partway through.
 * Hence the deliberately reversed-latency server below.
 */

import {
  MEDIA_FETCH_WINDOW,
  isSameOriginMediaUrl,
  probeMediaSize,
  toBlobMediaUrl,
} from "./mediaBlobUrl.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(
  isSameOriginMediaUrl("blob:http://localhost/abc"),
  "blob: is same-origin",
);
assert(
  isSameOriginMediaUrl("data:video/mp4;base64,xx"),
  "data: is same-origin",
);
assert(
  !isSameOriginMediaUrl("media://localhost/p/screen.mp4"),
  "media:// is cross-origin",
);
assert(
  !isSameOriginMediaUrl("http://media.localhost/p/screen.mp4"),
  "media host is cross-origin",
);

{
  const pass = await toBlobMediaUrl("blob:already-same");
  assert(pass.src === "blob:already-same", "blob passthrough keeps src");
  pass.revoke(); // no-op
}

// --- fake media:// server --------------------------------------------------

const CONTENT_TYPE = "video/mp4";
/** Three windows, the last one short — the shape a real recording has. */
const TOTAL = 2 * MEDIA_FETCH_WINDOW + 12345;

/** Deterministic and position-dependent, so a misplaced window cannot pass. */
const byteAt = (n: number): number => n % 251;

function expectedBytes(total: number): Uint8Array {
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) out[i] = byteAt(i);
  return out;
}

type ServerOptions = {
  total: number;
  /** Latency for the window starting at `start`, in ms. Default 0. */
  delayFor?: (start: number) => number;
  /** Drop `Content-Range` from every response (forces the serial fallback). */
  omitContentRange?: boolean;
  /** Answer any request with the whole body as a single 200. */
  wholeBody?: boolean;
  /** Serve 10 bytes fewer than asked for the window starting here. */
  truncateWindowAt?: number;
  /** Called with the inclusive range before each response is scheduled. */
  onRequest?: (start: number, end: number) => void;
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function parseRange(init: RequestInit | undefined): {
  start: number;
  end: number;
} {
  const raw = new Headers(init?.headers).get("Range") ?? "";
  const [start, end] = raw.replace("bytes=", "").split("-");
  return { start: Number(start), end: Number(end) };
}

/** Install a stub `fetch`; returns the uninstaller. */
function installServer(options: ServerOptions): () => void {
  const original = globalThis.fetch;

  const build = (start: number, end: number): Response => {
    if (options.wholeBody) {
      return new Response(expectedBytes(options.total), {
        status: 200,
        headers: { "Content-Type": CONTENT_TYPE, "Accept-Ranges": "bytes" },
      });
    }

    if (start >= options.total) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${options.total}` },
      });
    }

    let last = Math.min(end, options.total - 1);
    if (options.truncateWindowAt === start) last = Math.max(start, last - 10);

    const body = new Uint8Array(last - start + 1);
    for (let i = 0; i < body.length; i += 1) body[i] = byteAt(start + i);

    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPE,
      "Accept-Ranges": "bytes",
    };
    if (!options.omitContentRange) {
      headers["Content-Range"] = `bytes ${start}-${last}/${options.total}`;
    }
    return new Response(body, { status: 206, headers });
  };

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const { start, end } = parseRange(init);
    options.onRequest?.(start, end);

    const signal = init?.signal ?? undefined;
    const delay = options.delayFor?.(start) ?? 0;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(build(start, end));
      }, delay);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/** Capture the Blob handed to `createObjectURL` so its bytes can be asserted. */
function captureBlobs(): { blobs: Blob[]; restore: () => void } {
  const blobs: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    blobs.push(blob);
    return `blob:stub/${blobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  return {
    blobs,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

async function assertBlobBytes(
  blob: Blob,
  expected: Uint8Array,
  label: string,
): Promise<void> {
  assert(
    blob.size === expected.length,
    `${label}: size ${blob.size} != ${expected.length}`,
  );
  const actual = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${label}: byte ${i} is ${actual[i]}, expected ${expected[i]}`,
      );
    }
  }
}

/** Run `body` against a stubbed server + blob capture, always cleaning up. */
async function withServer(
  options: ServerOptions,
  body: (blobs: Blob[]) => Promise<void>,
): Promise<void> {
  const capture = captureBlobs();
  const uninstall = installServer(options);
  try {
    await body(capture.blobs);
  } finally {
    uninstall();
    capture.restore();
  }
}

/** The message of whatever `body` throws, or "" when it resolves. */
async function messageOf(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// --- cases -----------------------------------------------------------------

const SCREEN = "media://localhost/p/screen.mp4";
const EXPECTED = expectedBytes(TOTAL);

// Concurrent assembly reproduces the file exactly.
await withServer({ total: TOTAL }, async (blobs) => {
  const media = await toBlobMediaUrl(SCREEN);
  assert(blobs.length === 1, "one blob created");
  await assertBlobBytes(blobs[0]!, EXPECTED, "concurrent assembly");
  assert(blobs[0]!.type === CONTENT_TYPE, "content type carried through");
  media.revoke();
});

// Reversed latency: the last window resolves first. Order must not matter.
{
  const windows = Math.ceil(TOTAL / MEDIA_FETCH_WINDOW);
  await withServer(
    {
      total: TOTAL,
      delayFor: (start) =>
        (windows - Math.floor(start / MEDIA_FETCH_WINDOW)) * 10,
    },
    async (blobs) => {
      const media = await toBlobMediaUrl(SCREEN);
      await assertBlobBytes(blobs[0]!, EXPECTED, "out-of-order assembly");
      media.revoke();
    },
  );
}

// A file smaller than one window, answered as a single 200.
await withServer({ total: 4096, wholeBody: true }, async (blobs) => {
  const media = await toBlobMediaUrl("media://localhost/p/small.mp4");
  await assertBlobBytes(blobs[0]!, expectedBytes(4096), "whole-body 200");
  media.revoke();
});

// No Content-Range → serial fallback, still byte-exact.
await withServer({ total: TOTAL, omitContentRange: true }, async (blobs) => {
  const media = await toBlobMediaUrl(SCREEN);
  await assertBlobBytes(blobs[0]!, EXPECTED, "serial fallback");
  media.revoke();
});

// Abort mid-flight rejects with an AbortError — the name `useSameOriginMediaUrl`
// swallows. Anything else surfaces as a console error and a blank preview.
{
  const controller = new AbortController();
  let served = 0;
  await withServer(
    {
      total: TOTAL,
      delayFor: () => 10,
      onRequest: () => {
        served += 1;
        if (served === 2) controller.abort();
      },
    },
    async (blobs) => {
      let name = "";
      try {
        await toBlobMediaUrl(SCREEN, { signal: controller.signal });
      } catch (e) {
        name = e instanceof Error ? e.name : String(e);
      }
      assert(name === "AbortError", `abort surfaces AbortError, got "${name}"`);
      assert(blobs.length === 0, "aborted read creates no blob");
    },
  );
}

// A short window means a truncated recording — fail loudly, never assemble it.
await withServer(
  { total: TOTAL, truncateWindowAt: MEDIA_FETCH_WINDOW },
  async (blobs) => {
    const message = await messageOf(() => toBlobMediaUrl(SCREEN));
    assert(
      message.includes("media read incomplete"),
      `truncated read is detected, got "${message}"`,
    );
    assert(blobs.length === 0, "truncated read creates no blob");
  },
);

// A file with no bytes is reported as empty, not as a zero-length blob.
await withServer({ total: 0 }, async (blobs) => {
  const message = await messageOf(() =>
    toBlobMediaUrl("media://localhost/p/empty.mp4"),
  );
  assert(
    message === "media is empty",
    `empty media is reported, got "${message}"`,
  );
  assert(blobs.length === 0, "empty read creates no blob");
});

// `probeMediaSize` decides whether the preview waits for the proxy or opens
// against the original, so it must cost one request and never assemble a blob.
await withServer({ total: TOTAL }, async (blobs) => {
  let requests = 0;
  const counted = installServer({
    total: TOTAL,
    onRequest: () => (requests += 1),
  });
  const size = await probeMediaSize(SCREEN);
  counted();
  assert(size === TOTAL, `probe reports the total, got ${size}`);
  assert(requests === 1, `probe costs one request, made ${requests}`);
  assert(blobs.length === 0, "probe materializes nothing");
});

// A server with no Content-Range gives no size — the caller must not read that
// as "empty" and skip the file.
await withServer({ total: TOTAL, omitContentRange: true }, async () => {
  assert(
    (await probeMediaSize(SCREEN)) === null,
    "missing Content-Range → null",
  );
});

// A whole-body 200 still yields a usable size.
await withServer({ total: 4096, wholeBody: true }, async () => {
  const size = await probeMediaSize("media://localhost/p/small.mp4");
  assert(size === 4096, `whole-body probe reports the size, got ${size}`);
});

// Abort propagates by name, same as the assembler.
await withServer({ total: TOTAL, delayFor: () => 10 }, async () => {
  const controller = new AbortController();
  const pending = probeMediaSize(SCREEN, { signal: controller.signal });
  controller.abort();
  let name = "";
  try {
    await pending;
  } catch (e) {
    name = e instanceof Error ? e.name : String(e);
  }
  assert(
    name === "AbortError",
    `probe abort surfaces AbortError, got "${name}"`,
  );
});

console.log("mediaBlobUrl.selfcheck: ok");
