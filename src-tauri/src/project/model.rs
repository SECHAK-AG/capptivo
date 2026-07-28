//! Serde structs for the on-disk project format (TAURI_DESKTOP_MIGRATION.md §9).
//! `schemaVersion` is present from day one with an explicit migration seam so the
//! format can evolve without corrupting old recordings.

use serde::{Deserialize, Serialize};

/// Current project schema. Bump + add a `migrate_vN_to_vN+1` when the shape
/// changes; [`super::store::ProjectStore::load`] runs migrations on read.
pub const SCHEMA_VERSION: u32 = 1;

/// `project.json` — the manifest for one recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: String,
    pub title: Option<String>,
    /// RFC 3339 timestamp.
    pub created_at: String,
    pub capture: CaptureSnapshot,
    pub files: ProjectFiles,
    /// Opaque editor JSON (`segments`, `look`, `cursorSettings`, …) — same shape as
    /// the web app `editor_state` column for cloud sync without conversion.
    #[serde(default)]
    pub editor_state: Option<serde_json::Value>,
}

/// The capture configuration a recording was made with (for reproducibility and
/// display in a future library UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshot {
    pub source_title: String,
    pub fps: u32,
    pub captured_system_audio: bool,
    /// `true` when the OS cursor was composited into `screen.mp4` (legacy).
    /// New recordings always write `false` and redraw the cursor in the editor.
    #[serde(default = "default_shows_system_cursor")]
    pub shows_system_cursor: bool,
}

fn default_shows_system_cursor() -> bool {
    // Missing field on older projects → assume baked cursor (avoid double-draw).
    true
}

/// Relative file names within the project directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub screen: String,
    pub camera: Option<String>,
    pub cursor: Option<String>,
    pub meta: String,
    pub thumbnail: Option<String>,
}

impl Default for ProjectFiles {
    fn default() -> Self {
        Self {
            screen: "screen.mp4".into(),
            camera: None,
            cursor: Some("cursor.json".into()),
            meta: "meta.json".into(),
            thumbnail: None,
        }
    }
}

/// `meta.json` — technical metadata + capture health stats.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_seconds: f64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    /// Display backing scale factor at capture time (points → pixels).
    pub scale_factor: f64,
}

/// Lightweight summary for the recorder popover's "recent recordings" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub duration_seconds: f64,
    pub thumbnail: Option<String>,
}
