/**
 * The single source of platform truth for the frontend.
 *
 * OS detection is sync (UA sniff — reliable inside our own WebViews) so it can
 * gate rendering on first paint. Behavioral flags come from Rust's
 * `platform_capabilities` command instead of scattered platform sniffs — see
 * `capabilities.rs` for the honest per-OS degradations they encode.
 */

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const plat = typeof navigator !== "undefined" ? navigator.platform || "" : "";

export const isMacOS = /Mac/i.test(plat) || /Macintosh/i.test(ua);
export const isWindows = /Win/i.test(plat) || /Windows/i.test(ua);
export const isLinux = !isMacOS && !isWindows && /Linux/i.test(`${plat} ${ua}`);

/**
 * Base URL of the `media://` custom protocol. Tauri serves custom schemes as
 * `http://<scheme>.localhost` on Windows (WebView2) and `<scheme>://localhost`
 * on macOS/Linux — hardcoding one form 404s every video on the other.
 */
export const MEDIA_PROTOCOL_BASE = isWindows
  ? "http://media.localhost"
  : "media://localhost";

/** media base + `/<projectId>/<file>` — served with HTTP Range by Rust. */
export function mediaUrl(projectId: string, file: string): string {
  return `${MEDIA_PROTOCOL_BASE}/${projectId}/${file}`;
}
