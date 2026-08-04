//! Client log IPC — JS errors/info + tray “Open Error Log…” / logs folder.

use crate::error::AppResult;
use crate::error_log;
use tauri::AppHandle;

/// Append a frontend error to `errors.log` (and surface as `tracing::error!`).
#[tauri::command(async)]
pub fn log_client_error(source: String, message: String) -> AppResult<()> {
    if message.trim().is_empty() {
        return Ok(());
    }
    let src = if source.trim().is_empty() {
        "js"
    } else {
        source.trim()
    };
    tracing::error!(target: "js", source = %src, "{message}");
    Ok(())
}

/// Append a frontend info line to the rolling `capptivo.log` (not `errors.log`).
#[tauri::command(async)]
pub fn log_client_info(source: String, message: String) -> AppResult<()> {
    if message.trim().is_empty() {
        return Ok(());
    }
    let src = if source.trim().is_empty() {
        "js"
    } else {
        source.trim()
    };
    tracing::info!(target: "js", source = %src, "{message}");
    Ok(())
}

/// Reveal `logs/errors.log` in Finder / Explorer.
#[tauri::command(async)]
pub fn reveal_error_log(_app: AppHandle) -> AppResult<String> {
    let path = error_log::reveal()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Reveal the logs folder (`capptivo.*` + `errors.log`).
#[tauri::command(async)]
pub fn reveal_logs_dir(_app: AppHandle) -> AppResult<String> {
    let path = error_log::reveal_dir()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Absolute path of the error log (may not exist yet).
#[tauri::command]
pub fn error_log_path() -> AppResult<String> {
    Ok(error_log::log_path().to_string_lossy().into_owned())
}
