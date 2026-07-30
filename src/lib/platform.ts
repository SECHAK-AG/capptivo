/** Frontend platform detection + `media://` URL helpers. */

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const plat = typeof navigator !== "undefined" ? navigator.platform || "" : "";

export const isMacOS = /Mac/i.test(plat) || /Macintosh/i.test(ua);
export const isWindows = /Win/i.test(plat) || /Windows/i.test(ua);
export const isLinux = !isMacOS && !isWindows && /Linux/i.test(`${plat} ${ua}`);

/** `media://` base URL — WebView2 uses `http://media.localhost`, others use `media://localhost`. */
export const MEDIA_PROTOCOL_BASE = isWindows
  ? "http://media.localhost"
  : "media://localhost";

/** Reserved first path segment for the global custom-background library. */
export const CUSTOM_BACKGROUND_MEDIA_PREFIX = "_backgrounds";

/** media base + `/<projectId>/<file>` — served with HTTP Range by Rust. */
export function mediaUrl(projectId: string, file: string): string {
  return `${MEDIA_PROTOCOL_BASE}/${projectId}/${file}`;
}

/** Global custom background file under `{app_data}/backgrounds/`. */
export function customBackgroundUrl(fileName: string): string {
  return `${MEDIA_PROTOCOL_BASE}/${CUSTOM_BACKGROUND_MEDIA_PREFIX}/${fileName}`;
}
