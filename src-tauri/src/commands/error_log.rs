//! Client error log IPC — JS + tray “Open Error Log…”.

use crate::error::AppResult;
use crate::error_log;
use tauri::AppHandle;

/// Append a frontend error to the on-disk error log (errors only).
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
    error_log::append(src, &message);
    Ok(())
}

/// Reveal `logs/errors.log` in Finder / Explorer.
#[tauri::command(async)]
pub fn reveal_error_log(_app: AppHandle) -> AppResult<String> {
    let path = error_log::reveal()?;
    Ok(path.to_string_lossy().into_owned())
}

/// Absolute path of the error log (may not exist yet).
#[tauri::command]
pub fn error_log_path() -> AppResult<String> {
    Ok(error_log::log_path().to_string_lossy().into_owned())
}
