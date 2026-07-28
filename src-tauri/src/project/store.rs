//! The local project store — the desktop replacement for the `recordings` table
//! + S3. One directory per recording under the app data dir. All writes are
//! atomic (write `.tmp`, fsync, rename) so a crash never corrupts a project.

use super::model::{
    CaptureSnapshot, Meta, Project, ProjectFiles, ProjectSummary, SCHEMA_VERSION,
};
use crate::cursor::CursorTrack;
use crate::error::{AppError, AppResult};
use crate::recorder::types::RecorderConfig;
use crate::recorder::RecordingArtifacts;
use parking_lot::Mutex;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct ProjectStore {
    root: PathBuf,
    /// Serializes the read-modify-write sequences on `project.json`.
    ///
    /// `save_editor_state`, `rename` and `ensure_thumbnail` each load the
    /// manifest, change one field, and write it back. Those used to be
    /// implicitly serialized by the fact that their commands ran on the app's
    /// single main thread; they now execute on a worker pool, so two overlapping
    /// calls could interleave and the later write would clobber the earlier
    /// one's field — a rename landing mid-`save_editor_state` silently reverts
    /// the title.
    ///
    /// It also covers a second race: [`write_json_atomic`] stages through a
    /// fixed `project.tmp`, so two concurrent writers to the same project would
    /// fight over that one staging file.
    ///
    /// Go through [`Self::update_project`] rather than taking this directly —
    /// one lock site is one place to get it right.
    manifest_write: Mutex<()>,
}

impl ProjectStore {
    /// `root` is the app data dir (e.g. `~/Library/Application Support/Capptivo`).
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            manifest_write: Mutex::new(()),
        }
    }

    fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    fn dir_for(&self, id: &str) -> PathBuf {
        self.projects_dir().join(id)
    }

    /// Absolute path to a project directory (for camera / media writers).
    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.dir_for(id)
    }

    /// Create a fresh, empty project directory and return its id + path. The
    /// recorder streams `screen.mp4` into this directory; [`Self::write_recording_stub`]
    /// writes a minimal manifest at start so the editor can open before finalize.
    pub fn create(&self) -> AppResult<(String, PathBuf)> {
        let id = new_project_id();
        let dir = self.dir_for(&id);
        fs::create_dir_all(&dir)?;
        Ok((id, dir))
    }

    /// Minimal `project.json` written at record-start so the editor can open while
    /// FFmpeg finalizes. [`Self::finalize`] overwrites this with full metadata.
    pub fn write_recording_stub(&self, id: &str, config: &RecorderConfig) -> AppResult<()> {
        let project = Project {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            title: None,
            created_at: now_rfc3339(),
            capture: CaptureSnapshot {
                source_title: config.source_id.clone(),
                fps: config.fps,
                captured_system_audio: config.capture_system_audio,
                shows_system_cursor: false,
            },
            files: ProjectFiles::default(),
            editor_state: None,
        };
        self.write_project(&project)
    }

    /// Write `cursor.json`, `meta.json`, and `project.json` after a recording has
    /// finished. `screen.mp4` is already in place (streamed during capture).
    pub fn finalize(
        &self,
        id: &str,
        config: &RecorderConfig,
        artifacts: &RecordingArtifacts,
    ) -> AppResult<Project> {
        let dir = self.dir_for(id);
        if !dir.is_dir() {
            return Err(AppError::Project(format!("project {id} does not exist")));
        }

        write_json_atomic(&dir.join("cursor.json"), &artifacts.cursor)?;

        let meta = Meta {
            width: artifacts.width,
            height: artifacts.height,
            fps: artifacts.fps,
            duration_seconds: artifacts.stats.duration_seconds,
            frames_encoded: artifacts.stats.frames_encoded,
            frames_dropped: artifacts.stats.frames_dropped,
            scale_factor: artifacts.cursor.scale_factor,
        };
        write_json_atomic(&dir.join("meta.json"), &meta)?;

        let mut files = ProjectFiles::default();
        if dir.join(super::thumbnail::THUMBNAIL_FILE).is_file() {
            files.thumbnail = Some(super::thumbnail::THUMBNAIL_FILE.to_string());
        }
        // Ignore empty stubs — MediaRecorder must have written real bytes.
        if camera_file_usable(&dir.join("camera.webm")) {
            files.camera = Some("camera.webm".into());
        } else if camera_file_usable(&dir.join("camera.mp4")) {
            files.camera = Some("camera.mp4".into());
        }

        let project = Project {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            title: None,
            created_at: now_rfc3339(),
            capture: CaptureSnapshot {
                source_title: config.source_id.clone(),
                fps: config.fps,
                captured_system_audio: config.capture_system_audio,
                shows_system_cursor: false,
            },
            files,
            editor_state: None,
        };
        self.write_project(&project)?;
        Ok(project)
    }

    pub fn load(&self, id: &str) -> AppResult<Project> {
        let path = self.dir_for(id).join("project.json");
        let bytes = fs::read(&path).map_err(|e| {
            AppError::Project(format!("cannot read project {id}: {e}"))
        })?;
        let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
        migrate(&mut value);
        let project: Project = serde_json::from_value(value)?;
        Ok(project)
    }

    /// Load `project.json`, apply `mutate`, write it back — holding
    /// [`Self::manifest_write`] for the whole sequence.
    ///
    /// Every partial update to a manifest must come through here. A caller that
    /// hand-rolls load → mutate → write reintroduces the lost-update race the
    /// lock exists to close.
    fn update_project(&self, id: &str, mutate: impl FnOnce(&mut Project)) -> AppResult<()> {
        let _guard = self.manifest_write.lock();
        let mut project = self.load(id)?;
        mutate(&mut project);
        self.write_project(&project)
    }

    pub fn save_editor_state(&self, id: &str, state: serde_json::Value) -> AppResult<()> {
        self.update_project(id, move |project| project.editor_state = Some(state))
    }

    pub fn rename(&self, id: &str, title: Option<String>) -> AppResult<()> {
        self.update_project(id, move |project| project.title = title)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let dir = self.dir_for(id);
        if dir.is_dir() {
            fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    /// Ensure `thumbnail.jpg` exists (one-shot FFmpeg backfill for older projects).
    /// Returns the relative file name when a poster is available.
    pub fn ensure_thumbnail(&self, id: &str) -> AppResult<Option<String>> {
        let dir = self.dir_for(id);
        let thumb = dir.join(super::thumbnail::THUMBNAIL_FILE);
        if thumb.is_file() {
            return Ok(Some(super::thumbnail::THUMBNAIL_FILE.to_string()));
        }
        let screen = dir.join("screen.mp4");
        if !screen.is_file() {
            return Ok(None);
        }
        // Deliberately outside the manifest lock: this is a whole FFmpeg run and
        // holding the lock across it would block every editor autosave for its
        // duration.
        super::thumbnail::extract_from_mp4(&screen, &thumb)?;
        // Persist the path on the manifest so other clients see it. Best-effort:
        // the poster is on disk either way, and `list()` prefers the file over
        // this field precisely so a failure here is cosmetic.
        let _ = self.update_project(id, |project| {
            project.files.thumbnail = Some(super::thumbnail::THUMBNAIL_FILE.to_string());
        });
        Ok(Some(super::thumbnail::THUMBNAIL_FILE.to_string()))
    }

    pub fn list(&self) -> AppResult<Vec<ProjectSummary>> {
        let dir = self.projects_dir();
        if !dir.is_dir() {
            return Ok(Vec::new());
        }

        let mut summaries = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // Skip half-written projects (no manifest yet).
            let Ok(project) = self.load(&id) else {
                continue;
            };
            let duration = self.read_meta(&id).map(|m| m.duration_seconds).unwrap_or(0.0);
            let thumb = self.dir_for(&id).join(super::thumbnail::THUMBNAIL_FILE);
            summaries.push(ProjectSummary {
                id: project.id,
                title: project.title,
                created_at: project.created_at,
                duration_seconds: duration,
                // Prefer the on-disk poster (authoritative) over a stale manifest field.
                thumbnail: thumb.is_file().then(|| super::thumbnail::THUMBNAIL_FILE.to_string()),
            });
        }
        // Newest first (ids are date-prefixed, so lexicographic desc works).
        summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(summaries)
    }

    fn read_meta(&self, id: &str) -> AppResult<Meta> {
        let bytes = fs::read(self.dir_for(id).join("meta.json"))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// The original recording's pixel dimensions (from `meta.json`). Authoritative
    /// for export sizing — the editor must not derive these from a preview proxy.
    pub fn recording_size(&self, id: &str) -> AppResult<(u32, u32)> {
        let meta = self.read_meta(id)?;
        Ok((meta.width, meta.height))
    }

    /// Read a project's `cursor.json`, if present. (Consumed by the
    /// `DesktopEditorHost` metadata load in Phase 4.)
    #[allow(dead_code)]
    pub fn load_cursor(&self, id: &str) -> AppResult<Option<CursorTrack>> {
        let path = self.dir_for(id).join("cursor.json");
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path)?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    fn write_project(&self, project: &Project) -> AppResult<()> {
        let path = self.dir_for(&project.id).join("project.json");
        write_json_atomic(&path, project)
    }

    /// The absolute projects root; the media protocol scopes reads to this.
    #[allow(dead_code)] // the media protocol resolves this itself today.
    pub fn projects_root(&self) -> PathBuf {
        self.projects_dir()
    }
}

/// `2026-07-21-a8f3c1` — date-prefixed for human-sortable directories, with a
/// short random suffix to avoid collisions within a day.
fn new_project_id() -> String {
    let date = chrono::Local::now().format("%Y-%m-%d");
    let short = uuid::Uuid::new_v4().simple().to_string();
    format!("{date}-{}", &short[..6])
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Atomic JSON write: serialize to `<path>.tmp`, fsync, then rename over `path`.
fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        let bytes = serde_json::to_vec_pretty(value)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn camera_file_usable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 2048)
        .unwrap_or(false)
}

/// Apply in-place migrations to a raw project value based on its `schemaVersion`.
/// v1 is current, so this is a no-op today — but the seam exists from day one.
fn migrate(value: &mut serde_json::Value) {
    let version = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;
    // Future: `if version < 2 { migrate_v1_to_v2(value); }`
    let _ = version;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::types::{QualityPreset, RecorderConfig};
    use std::sync::Arc;

    /// A store rooted in a fresh temp directory, plus one project with a
    /// manifest already on disk. The caller deletes `root` when done.
    fn store_with_project() -> (ProjectStore, String, PathBuf) {
        let root = std::env::temp_dir()
            .join(format!("capptivo-store-test-{}", uuid::Uuid::new_v4().simple()));
        let store = ProjectStore::new(root.clone());
        let (id, _dir) = store.create().expect("create project dir");
        let config = RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            quality: QualityPreset::default(),
        };
        store
            .write_recording_stub(&id, &config)
            .expect("write manifest stub");
        (store, id, root)
    }

    /// `save_editor_state` and `rename` are load → mutate → write sequences.
    /// Their commands used to be serialized by running on the app's single main
    /// thread; they now execute on a worker pool, so `ProjectStore` has to
    /// serialize them itself.
    ///
    /// Two failures are possible without `manifest_write`, and this exercises
    /// both: a lost update (one writer's field reverted by the other's stale
    /// read) and a torn manifest (both writers stage through the same fixed
    /// `project.tmp`, so a reader can parse a half-written file).
    #[test]
    fn concurrent_manifest_writes_do_not_clobber() {
        let (store, id, root) = store_with_project();
        let store = Arc::new(store);

        const THREADS_PER_KIND: usize = 4;
        const ITERATIONS: usize = 40;

        let mut handles = Vec::new();
        for t in 0..THREADS_PER_KIND {
            let store = Arc::clone(&store);
            let id = id.clone();
            handles.push(std::thread::spawn(move || -> Result<(), String> {
                for i in 0..ITERATIONS {
                    let value = serde_json::json!({ "thread": t, "iteration": i });
                    store
                        .save_editor_state(&id, value)
                        .map_err(|e| format!("save_editor_state failed: {e}"))?;
                }
                Ok(())
            }));
        }
        for t in 0..THREADS_PER_KIND {
            let store = Arc::clone(&store);
            let id = id.clone();
            handles.push(std::thread::spawn(move || -> Result<(), String> {
                for i in 0..ITERATIONS {
                    store
                        .rename(&id, Some(format!("title-{t}-{i}")))
                        .map_err(|e| format!("rename failed: {e}"))?;
                }
                Ok(())
            }));
        }

        let errors: Vec<String> = handles
            .into_iter()
            .filter_map(|h| h.join().expect("worker panicked").err())
            .collect();

        let project = store.load(&id);
        let _ = fs::remove_dir_all(&root);

        assert!(errors.is_empty(), "manifest writes raced: {errors:?}");

        let project = project.expect("manifest still parses after concurrent writes");
        assert!(
            project.editor_state.is_some(),
            "editor state was clobbered by a concurrent rename",
        );
        assert!(
            project.title.is_some(),
            "title was clobbered by a concurrent editor-state save",
        );
    }

    /// The lock is taken once per update. `update_project` calls `load`, which
    /// must **not** take it — a reentrant acquisition on a non-reentrant mutex
    /// deadlocks, and this test hangs rather than fails if that regresses.
    #[test]
    fn update_project_does_not_deadlock_on_its_own_read() {
        let (store, id, root) = store_with_project();
        let result = store.rename(&id, Some("once".into()));
        let reloaded = store.load(&id);
        let _ = fs::remove_dir_all(&root);

        result.expect("rename");
        assert_eq!(reloaded.expect("load").title.as_deref(), Some("once"));
    }
}
