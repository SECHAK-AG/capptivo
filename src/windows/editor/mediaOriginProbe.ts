/**
 * TEMPORARY experiment — plan 008, step 2. DELETE once the gate is decided.
 *
 * Question: can a `<video>` loaded from a given URL have its pixels read back /
 * uploaded to the GPU, or does WKWebView mark the canvas tainted?
 *
 * `getImageData` consults the same origin-clean flag that WebGL's `texImage2D`
 * and WebGPU's `copyExternalImageToTexture` do, so a 2D readback is a faithful —
 * and far cheaper — stand-in for the real upload path.
 */

export type MediaOriginProbeResult = {
  label: string;
  url: string;
  crossOrigin: "anonymous" | null;
  loaded: boolean;
  originClean: boolean;
  error: string | null;
};

const LOAD_TIMEOUT_MS = 15_000;

export async function probeMediaOrigin(
  label: string,
  url: string,
  crossOrigin: "anonymous" | null,
): Promise<MediaOriginProbeResult> {
  const base = { label, url, crossOrigin };
  const video = document.createElement("video");
  if (crossOrigin) video.crossOrigin = crossOrigin;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("load timed out")), LOAD_TIMEOUT_MS);
      video.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          const code = video.error?.code ?? "?";
          reject(new Error(`load failed (MediaError ${code})`));
        },
        { once: true },
      );
      video.src = url;
    });
  } catch (e) {
    return { ...base, loaded: false, originClean: false, error: String(e) };
  }

  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { ...base, loaded: true, originClean: false, error: "no 2d context" };
  }

  try {
    ctx.drawImage(video, 0, 0, 16, 16);
    ctx.getImageData(0, 0, 1, 1);
    return { ...base, loaded: true, originClean: true, error: null };
  } catch (e) {
    return { ...base, loaded: true, originClean: false, error: String(e) };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Run the three cases the gate needs and report each one.
 *
 * Results are reported by `fetch`ing the throwaway gate server with the outcome
 * in the path: the probe runs inside a WebView whose console is not forwarded to
 * the dev server's stdout, and the gate server's request log is the one channel
 * already visible from a terminal.
 */
export async function runMediaOriginGate(
  mediaUrlFor: (file: string) => string,
  loopbackBase: string,
  projectId: string,
): Promise<void> {
  const report = (line: string) =>
    void fetch(`${loopbackBase}/__gate/${encodeURIComponent(line)}`).catch(() => undefined);

  report("gate-start");

  const cases: Array<[string, string, "anonymous" | null]> = [
    ["custom-scheme-no-crossOrigin", mediaUrlFor("screen.mp4"), null],
    ["custom-scheme-with-crossOrigin", mediaUrlFor("screen.mp4"), "anonymous"],
    ["loopback-http-with-crossOrigin", `${loopbackBase}/${projectId}/screen.mp4`, "anonymous"],
  ];

  for (const [label, url, crossOrigin] of cases) {
    const result = await probeMediaOrigin(label, url, crossOrigin);
    report(
      `RESULT ${result.label} loaded=${result.loaded} ` +
        `originClean=${result.originClean} error=${(result.error ?? "none").replace(/\s+/g, "_")}`,
    );
  }

  report("gate-done");
}
