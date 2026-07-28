//! One-time download of ggml-small.bin (whisper.cpp weights) into app data.

use crate::captions::types::{WhisperDownloadProgress, WhisperModelStatus};
use crate::error::{AppError, AppResult};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

pub const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const MODEL_FILE: &str = "ggml-small.bin";

pub fn model_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("app data dir: {e}")))?
        .join("whisper");
    Ok(dir)
}

pub fn model_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(model_dir(app)?.join(MODEL_FILE))
}

pub fn model_status(app: &AppHandle) -> AppResult<WhisperModelStatus> {
    let path = model_path(app)?;
    let exists = path.is_file();
    Ok(WhisperModelStatus {
        exists,
        path: exists.then(|| path.to_string_lossy().into_owned()),
    })
}

pub fn emit_progress(app: &AppHandle, payload: WhisperDownloadProgress) {
    let _ = app.emit("captions://model-download", &payload);
}

pub async fn download_model(app: AppHandle) -> AppResult<PathBuf> {
    let dir = model_dir(&app)?;
    let dest = model_path(&app)?;
    if dest.is_file() {
        emit_progress(
            &app,
            WhisperDownloadProgress {
                status: "downloaded".into(),
                progress: 100,
                path: Some(dest.to_string_lossy().into_owned()),
                error: None,
            },
        );
        return Ok(dest);
    }

    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(format!("mkdir whisper: {e}")))?;
    let temp = dest.with_extension("bin.download");

    emit_progress(
        &app,
        WhisperDownloadProgress {
            status: "downloading".into(),
            progress: 0,
            path: None,
            error: None,
        },
    );

    let app2 = app.clone();
    let dest2 = dest.clone();
    let temp2 = temp.clone();
    tauri::async_runtime::spawn_blocking(move || download_file(&app2, &temp2, &dest2))
        .await
        .map_err(|e| AppError::Other(format!("download task: {e}")))??;

    Ok(dest)
}

fn download_file(app: &AppHandle, temp: &Path, dest: &Path) -> AppResult<()> {
    let response = ureq::get(WHISPER_MODEL_URL)
        .call()
        .map_err(|e| AppError::Other(format!("model download request failed: {e}")))?;
    if !(200..300).contains(&response.status()) {
        return Err(AppError::Other(format!(
            "model download HTTP {}",
            response.status()
        )));
    }

    let total = response
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.into_reader();
    let mut file = File::create(temp).map_err(|e| AppError::Other(format!("temp file: {e}")))?;
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_pct = 0u8;

    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)
            .map_err(|e| AppError::Other(format!("download read: {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| AppError::Other(format!("download write: {e}")))?;
        downloaded += n as u64;
        if total > 0 {
            let pct = ((downloaded * 100) / total).min(100) as u8;
            if pct >= last_pct.saturating_add(2) || pct == 100 {
                last_pct = pct;
                emit_progress(
                    app,
                    WhisperDownloadProgress {
                        status: "downloading".into(),
                        progress: pct,
                        path: None,
                        error: None,
                    },
                );
            }
        }
    }

    file.sync_all()
        .map_err(|e| AppError::Other(format!("download sync: {e}")))?;
    std::fs::rename(temp, dest).map_err(|e| AppError::Other(format!("rename model: {e}")))?;

    emit_progress(
        app,
        WhisperDownloadProgress {
            status: "downloaded".into(),
            progress: 100,
            path: Some(dest.to_string_lossy().into_owned()),
            error: None,
        },
    );
    Ok(())
}

pub fn delete_model(app: &AppHandle) -> AppResult<()> {
    let path = model_path(app)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| AppError::Other(format!("delete model: {e}")))?;
    }
    emit_progress(
        app,
        WhisperDownloadProgress {
            status: "idle".into(),
            progress: 0,
            path: None,
            error: None,
        },
    );
    Ok(())
}
