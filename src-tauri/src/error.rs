//! One error type per the domain, surfaced across the IPC boundary.
//!
//! `AppError` derives `Serialize` as an internally-tagged union so the frontend
//! receives `{ kind, message }` and can `switch (err.kind)` — no stringly-typed
//! error parsing. Commands return `Result<T, AppError>`.

use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error, Serialize, Clone)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    #[error("screen recording permission is not granted")]
    PermissionDenied,

    #[error("screen capture is not supported on this system")]
    Unsupported,

    #[error("capture source is invalid: {0}")]
    InvalidSource(String),

    #[error("recorder is busy (currently {0})")]
    Busy(String),

    #[error("no recording is in progress")]
    NotRecording,

    #[error("encoder failed: {0}")]
    Encoder(String),

    #[error("project store error: {0}")]
    Project(String),

    #[error("i/o error: {0}")]
    Io(String),

    #[error("{0}")]
    Other(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Project(e.to_string())
    }
}
