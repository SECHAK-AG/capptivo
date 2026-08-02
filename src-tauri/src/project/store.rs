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

/// The per-project manifest. [`write_json_atomic`] stages it through
/// `project.tmp`, which is why concurrent writers must share `manifest_write`.
const PROJECT_FILE: &str = "project.json";

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

    /// App data root — shared by projects, captions models, custom backgrounds.
    pub fn app_data_dir(&self) -> &Path {
        &self.root
    }

    fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    /// The single chokepoint for turning an id into a path — every path in this
    /// store goes through it, so [`validate_project_id`] here covers every
    /// command that takes a `project_id`. Keep it that way: no other call site
    /// may join an id onto [`Self::projects_dir`].
    fn dir_for(&self, id: &str) -> AppResult<PathBuf> {
        validate_project_id(id)?;
        Ok(self.projects_dir().join(id))
    }

    /// Absolute path to a project directory (for camera / media writers).
    pub fn project_dir(&self, id: &str) -> AppResult<PathBuf> {
        self.dir_for(id)
    }

    /// Create a fresh, empty project directory and return its id + path. The
    /// recorder streams `screen.mp4` into this directory; [`Self::write_recording_stub`]
    /// writes a minimal manifest at start so the editor can open before finalize.
    pub fn create(&self) -> AppResult<(String, PathBuf)> {
        let id = new_project_id();
        let dir = self.dir_for(&id)?;
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
        let dir = self.dir_for(id)?;
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
            camera_offset_ms: artifacts.camera_offset_ms,
        };
        write_json_atomic(&dir.join("meta.json"), &meta)?;

        let mut files = ProjectFiles::default();
        if dir.join(super::thumbnail::THUMBNAIL_FILE).is_file() {
            files.thumbnail = Some(super::thumbnail::THUMBNAIL_FILE.to_string());
        }
        // Ignore empty stubs — MediaRecorder must have written real bytes.
        // Prefers the normalized H.264 track when one is already there; the
        // editor's `ensure_camera_track` produces it and repins this field.
        files.camera = super::camera_track::resolve(&dir).map(str::to_string);

        // `files` / `capture` / `schema_version` are ours to own — they describe
        // the finished capture. `editor_state`, `title` and `created_at` belong
        // to whoever already touched the manifest: `write_recording_stub` set
        // `created_at` at record start, and the editor window is opened *before*
        // this runs (see `stop_recording`), so it may already have autosaved
        // edits and a rename. Writing a fresh `Project` here erased them.
        //
        // Going through `update_project` also takes `manifest_write`, which
        // serializes this against a concurrent `save_editor_state` and stops the
        // two of us from fighting over the shared `project.tmp` staging file.
        let capture = CaptureSnapshot {
            source_title: config.source_id.clone(),
            fps: config.fps,
            captured_system_audio: config.capture_system_audio,
            shows_system_cursor: false,
        };
        let merged = self.update_project(id, {
            let capture = capture.clone();
            let files = files.clone();
            move |project| {
                project.schema_version = SCHEMA_VERSION;
                project.capture = capture;
                project.files = files;
                // Keep the manifest's identity pinned to the directory it was
                // read from — `write_project` derives its path from this field.
                project.id = id.to_string();
            }
        });

        match merged {
            Ok(()) => self.load(id),
            // No manifest to merge into (the record-start stub never landed), so
            // there are genuinely no edits to preserve — the only case in which
            // `finalize` may originate a null editor state. Every other failure
            // (a corrupt manifest, a failed write) must propagate rather than
            // silently overwrite whatever is on disk.
            Err(_) if !dir.join(PROJECT_FILE).is_file() => {
                let project = Project {
                    schema_version: SCHEMA_VERSION,
                    id: id.to_string(),
                    title: None,
                    created_at: now_rfc3339(),
                    capture,
                    files,
                    editor_state: None,
                };
                self.write_project(&project)?;
                Ok(project)
            }
            Err(e) => Err(e),
        }
    }

    pub fn load(&self, id: &str) -> AppResult<Project> {
        let path = self.dir_for(id)?.join(PROJECT_FILE);
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

    /// Repoint the manifest at a face-cam file — used once per project after
    /// [`super::camera_track::ensure`] normalizes the recorded WebM.
    pub fn set_camera_file(&self, id: &str, camera: &str) -> AppResult<()> {
        let camera = camera.to_string();
        self.update_project(id, move |project| project.files.camera = Some(camera))
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let dir = self.dir_for(id)?;
        if dir.is_dir() {
            fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    /// Ensure `thumbnail.jpg` exists (one-shot FFmpeg backfill for older projects).
    /// Returns the relative file name when a poster is available.
    pub fn ensure_thumbnail(&self, id: &str) -> AppResult<Option<String>> {
        let dir = self.dir_for(id)?;
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
            // Ids come from `read_dir`, not IPC, so they are trustworthy — but a
            // directory a user created by hand can still fail validation. Skip
            // it rather than failing the whole listing.
            let Ok(dir) = self.dir_for(&id) else {
                continue;
            };
            // Skip half-written projects (no manifest yet).
            let Ok(project) = self.load(&id) else {
                continue;
            };
            let duration = self.read_meta(&id).map(|m| m.duration_seconds).unwrap_or(0.0);
            let thumb = dir.join(super::thumbnail::THUMBNAIL_FILE);
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
        let bytes = fs::read(self.dir_for(id)?.join("meta.json"))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// The original recording's pixel dimensions (from `meta.json`). Authoritative
    /// for export sizing — the editor must not derive these from a preview proxy.
    pub fn recording_size(&self, id: &str) -> AppResult<(u32, u32)> {
        let meta = self.read_meta(id)?;
        Ok((meta.width, meta.height))
    }

    /// Face-cam start offset in milliseconds relative to the screen's first
    /// frame. `None` for takes with no face-cam, and for takes recorded before
    /// the offset was measured.
    pub fn camera_offset_ms(&self, id: &str) -> Option<i64> {
        self.read_meta(id).ok().and_then(|m| m.camera_offset_ms)
    }

    /// Read a project's `cursor.json`, if present. (Consumed by the
    /// `DesktopEditorHost` metadata load in Phase 4.)
    #[allow(dead_code)]
    pub fn load_cursor(&self, id: &str) -> AppResult<Option<CursorTrack>> {
        let path = self.dir_for(id)?.join("cursor.json");
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path)?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    fn write_project(&self, project: &Project) -> AppResult<()> {
        let path = self.dir_for(&project.id)?.join(PROJECT_FILE);
        write_json_atomic(&path, project)
    }

    /// The absolute projects root; the media protocol scopes reads to this.
    ///
    /// Never join a caller-supplied `project_id` onto this — that bypasses the
    /// validation in [`Self::dir_for`]. Use [`Self::project_dir`] instead.
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

/// Reject any `project_id` that is not a bare directory name.
///
/// `project_id` arrives from the WebView as an arbitrary string, and ids are
/// generated by [`new_project_id`] as `YYYY-MM-DD-xxxxxx`, so an
/// ASCII-alphanumeric-plus-hyphen allowlist accepts every real project while
/// closing two escapes that `Path::join` would otherwise honor:
///
/// - `"../../etc"` — traversal above the projects root.
/// - `"/Users/me/Documents"` — an **absolute** path makes `join` discard the
///   base entirely, so the id becomes the whole path. A `..`-only check misses
///   this, and the sink is `fs::remove_dir_all`.
///
/// Rejecting `.` outright also rules out `.`, `..` and extension trickery; the
/// allowlist additionally excludes `/`, `\`, `:` (Windows drive letters) and NUL.
fn validate_project_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(AppError::Project(format!("invalid project id: {id:?}")));
    }
    Ok(())
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
        store
            .write_recording_stub(&id, &test_config())
            .expect("write manifest stub");
        (store, id, root)
    }

    /// The recorder's output, with every field at a trivial value. `finalize`
    /// only reads dimensions / stats / cursor off this, so zeros are enough.
    fn finalize_artifacts() -> RecordingArtifacts {
        RecordingArtifacts {
            screen_path: PathBuf::from("screen.mp4"),
            cursor: CursorTrack {
                scale_factor: 1.0,
                ..Default::default()
            },
            stats: Default::default(),
            width: 1920,
            height: 1080,
            fps: 30,
            error: None,
            interrupted: false,
            camera_offset_ms: None,
            media_lead_in_ms: 0,
        }
    }

    /// The config `stop_recording` hands to `finalize`.
    fn test_config() -> RecorderConfig {
        RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            microphone_device_id: None,
            microphone_label: None,
            quality: QualityPreset::default(),
        }
    }

    /// `stop_recording` opens the editor window *before* it calls `finalize`
    /// (the editor is capturable, so it must not appear in the recording's
    /// tail). The editor autosaves while the mic mux and progressive remux run,
    /// so `finalize` must merge into whatever is already on disk rather than
    /// writing a fresh manifest.
    #[test]
    fn finalize_preserves_editor_state_and_title() {
        let (store, id, root) = store_with_project();

        // Stand in for the editor autosaving + the user renaming while the
        // FFmpeg passes in `stop_recording` are still running.
        store
            .save_editor_state(&id, serde_json::json!({ "segments": [{ "start": 1.0 }] }))
            .expect("save editor state");
        store.rename(&id, Some("My take".into())).expect("rename");
        let created_before = store.load(&id).expect("load").created_at;

        let finalized = store.finalize(&id, &test_config(), &finalize_artifacts());

        let reloaded = store.load(&id);
        let _ = fs::remove_dir_all(&root);

        let finalized = finalized.expect("finalize");
        let reloaded = reloaded.expect("manifest parses after finalize");

        assert!(
            reloaded.editor_state.is_some(),
            "finalize erased the editor state the user had already saved",
        );
        assert_eq!(
            reloaded.title.as_deref(),
            Some("My take"),
            "finalize erased the user's rename",
        );
        assert_eq!(
            reloaded.created_at, created_before,
            "finalize reset created_at to finalize time",
        );
        // The fields finalize *does* own must still be applied.
        assert_eq!(finalized.capture.fps, 30);
        assert_eq!(reloaded.capture.fps, 30);
    }

    /// The fallback path: a project directory with no manifest at all (the
    /// record-start stub never landed). `finalize` must still produce a complete
    /// project rather than failing, since there are no edits to preserve.
    #[test]
    fn finalize_writes_a_full_manifest_when_the_stub_never_landed() {
        let (store, id, root) = store_with_project();
        fs::remove_file(store.dir_for(&id).expect("dir").join(PROJECT_FILE))
            .expect("remove manifest");

        let finalized = store.finalize(&id, &test_config(), &finalize_artifacts());
        let reloaded = store.load(&id);
        let _ = fs::remove_dir_all(&root);

        let finalized = finalized.expect("finalize must not fail without a stub");
        assert_eq!(finalized.id, id);
        assert!(finalized.editor_state.is_none());
        assert_eq!(reloaded.expect("manifest written").capture.fps, 30);
    }

    /// `finalize` used to call `write_project` directly, so it did not hold
    /// `manifest_write` — and `write_json_atomic` stages through a fixed
    /// `project.tmp`, so a concurrent autosave could observe a half-written
    /// manifest.
    #[test]
    fn finalize_does_not_race_concurrent_editor_saves() {
        let (store, id, root) = store_with_project();
        let store = Arc::new(store);

        let saver = {
            let store = Arc::clone(&store);
            let id = id.clone();
            std::thread::spawn(move || {
                for i in 0..50 {
                    let _ = store.save_editor_state(&id, serde_json::json!({ "i": i }));
                }
            })
        };

        let config = test_config();
        let artifacts = finalize_artifacts();
        for _ in 0..10 {
            let _ = store.finalize(&id, &config, &artifacts);
        }
        saver.join().expect("saver panicked");

        let reloaded = store.load(&id);
        let _ = fs::remove_dir_all(&root);

        let project = reloaded.expect("manifest still parses after concurrent finalize + saves");
        assert!(
            project.editor_state.is_some(),
            "an editor save was lost to a concurrent finalize",
        );
    }

    /// `project_id` arrives from the WebView as an arbitrary string. `dir_for`
    /// is the chokepoint that has to reject anything that is not a bare
    /// directory name, because the worst sink downstream is `remove_dir_all`.
    #[test]
    fn rejects_traversal_and_absolute_project_ids() {
        let (store, _id, root) = store_with_project();

        // `..` escapes the projects root.
        assert!(store.load("../../etc").is_err());
        assert!(store.delete("../../../tmp").is_err());
        // An absolute path makes `Path::join` discard the base entirely — this
        // is the case a `..`-only check would let through, and `delete` is
        // `fs::remove_dir_all`.
        assert!(store.delete("/tmp").is_err());
        assert!(store.load("/etc/passwd").is_err());
        // Separators and dots in any position.
        assert!(store.load("a/b").is_err());
        assert!(store.load("a\\b").is_err());
        assert!(store.load(".").is_err());
        assert!(store.load("").is_err());
        assert!(store.save_editor_state("../x", serde_json::json!({})).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    /// Regression guard on the other direction: the allowlist must not have
    /// become strict enough to lock users out of their own projects.
    #[test]
    fn accepts_generated_project_ids() {
        let (store, id, root) = store_with_project();
        // The id `store_with_project` created came from `new_project_id()`.
        let loaded = store.load(&id);
        let _ = fs::remove_dir_all(&root);
        assert!(loaded.is_ok(), "a generated id must still validate: {id}");
    }

    /// The end-to-end proof that the `fs::remove_dir_all` sink is closed: an
    /// absolute id used to make `projects_dir().join(id)` evaluate to `id`.
    #[test]
    fn delete_cannot_remove_a_directory_outside_the_store() {
        let (store, _id, root) = store_with_project();
        let bystander = std::env::temp_dir()
            .join(format!("capptivo-bystander-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&bystander).expect("create bystander dir");

        let result = store.delete(bystander.to_str().expect("utf8 path"));

        let survived = bystander.is_dir();
        let _ = fs::remove_dir_all(&bystander);
        let _ = fs::remove_dir_all(&root);

        assert!(result.is_err(), "absolute project id must be rejected");
        assert!(survived, "delete escaped the projects root");
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
