//! Frontend → file log bridge. Rust already uses `tracing`; this lets the
//! webviews dump uncaught errors into the same `capptivo.log`.

/// Append a JS-side message to the production log file (and stderr).
/// `level` is `error` | `warn` | anything else → info. Message capped so a
/// runaway loop can't fill the disk in one call.
#[tauri::command]
pub fn log_js(level: String, message: String) {
    const MAX: usize = 4_000;
    let msg = if message.len() > MAX {
        format!("{}…", &message[..MAX])
    } else {
        message
    };
    match level.as_str() {
        "error" => tracing::error!(target: "js", "{msg}"),
        "warn" => tracing::warn!(target: "js", "{msg}"),
        _ => tracing::info!(target: "js", "{msg}"),
    }
}
