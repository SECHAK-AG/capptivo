//! Engine errors. Messages are written for the export log a user can send in.

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{path}: {message}")]
    Media { path: String, message: String },
    #[error("{0}")]
    Process(String),
    #[error("GPU: {0}")]
    Gpu(String),
    #[error("render document: {0}")]
    Document(String),
    #[error("asset: {0}")]
    Asset(String),
    #[error("encoder: {0}")]
    Encode(String),
    #[error("export cancelled")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl EngineError {
    pub fn media(path: &Path, message: impl Into<String>) -> Self {
        Self::Media {
            path: path.display().to_string(),
            message: message.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
