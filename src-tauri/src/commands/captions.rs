use crate::captions::{
    self,
    types::{SilenceInterval, WhisperModelStatus, WhisperTranscriptArtifacts},
};
use crate::error::AppResult;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_whisper_model_status(app: AppHandle) -> AppResult<WhisperModelStatus> {
    captions::model_status(&app)
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle) -> AppResult<String> {
    let path = captions::download_model(app).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_whisper_model(app: AppHandle) -> AppResult<()> {
    captions::delete_model(&app)
}

#[tauri::command]
pub async fn detect_project_silences(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<SilenceInterval>> {
    let project_dir = state.store.project_dir(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || captions::detect_silences(&project_dir))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("silence task: {e}")))?
}

#[tauri::command]
pub async fn generate_captions(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    language: Option<String>,
) -> AppResult<WhisperTranscriptArtifacts> {
    let project_dir = state.store.project_dir(&project_id)?;
    let lang = language;
    tauri::async_runtime::spawn_blocking(move || {
        captions::generate(&app, &project_dir, lang.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(format!("caption task: {e}")))?
}
