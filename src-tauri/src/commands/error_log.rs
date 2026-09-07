//! Client diagnostics IPC with code-only persistence

use crate::error::AppResult;
use crate::error_log;
use tauri::AppHandle;

/// Persist one allowlisted source code, never the supplied error text
#[tauri::command(async)]
pub fn log_client_error(source: String, message: String) -> AppResult<()> {
    if message.trim().is_empty() {
        return Ok(());
    }
    error_log::append(error_log::client_error_code(&source));
    Ok(())
}

/// Development console information is not persisted to diagnostics
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

/// Reveal the code-only diagnostics file in the OS file manager
#[tauri::command(async)]
pub fn reveal_error_log(_app: AppHandle) -> AppResult<String> {
    let path = error_log::reveal()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Reveal the separate diagnostics folder without touching legacy logs
#[tauri::command(async)]
pub fn reveal_logs_dir(_app: AppHandle) -> AppResult<String> {
    let path = error_log::reveal_dir()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Native-owned diagnostics path, which may not exist yet
#[tauri::command]
pub fn error_log_path() -> AppResult<String> {
    Ok(error_log::log_path()?.to_string_lossy().into_owned())
}
