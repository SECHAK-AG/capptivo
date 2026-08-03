//! Windows WebView2 GPU browser arguments.
//!
//! Capptivo exports hammer WebGL inside WebView2. Pinning ANGLE to D3D11 and
//! ignoring the GPU blocklist reduces driver blacklists / wrong backends that
//! make context loss more likely. These flags do **not** replace JS-side
//! context-loss reclaim — they only harden the Chromium GPU path.
//!
//! When setting `additional_browser_args`, wry's defaults must be re-included
//! (see wry WebView2 builder docs).

use tauri::{AppHandle, WebviewWindowBuilder};

#[cfg(windows)]
const WEBVIEW2_GPU_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization"
);

/// Apply Windows GPU args. No-op on macOS/Linux (unsupported by wry).
pub fn apply_gpu_args(
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    #[cfg(windows)]
    {
        builder.additional_browser_args(WEBVIEW2_GPU_BROWSER_ARGS)
    }
    #[cfg(not(windows))]
    {
        builder
    }
}
