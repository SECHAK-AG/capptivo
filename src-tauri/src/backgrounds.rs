//! Global custom background images under `{app_data}/backgrounds/`.
//! Shared across every project — not stored next to a recording.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Reserved first segment of `media://localhost/_backgrounds/<file>`.
pub const MEDIA_PREFIX: &str = "_backgrounds";

const DIR_NAME: &str = "backgrounds";
const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomBackground {
    /// Stable id (= file stem). Persisted in editor state / presets.
    pub id: String,
    pub file_name: String,
}

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join(DIR_NAME)
}

pub fn save(app_data: &Path, bytes: &[u8], ext: &str) -> AppResult<CustomBackground> {
    if bytes.is_empty() {
        return Err(AppError::Other("empty background image".into()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(AppError::Other(format!(
            "background image too large (max {} MiB)",
            MAX_BYTES / (1024 * 1024)
        )));
    }
    let ext = normalize_ext(ext)?;
    let dir = dir(app_data);
    fs::create_dir_all(&dir)?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = format!("{id}.{ext}");
    let path = dir.join(&file_name);
    // Atomic-ish: write tmp then rename so a crash mid-write doesn't leave a
    // half file that `list` would happily serve.
    let tmp = dir.join(format!("{id}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;

    Ok(CustomBackground { id, file_name })
}

pub fn list(app_data: &Path) -> AppResult<Vec<CustomBackground>> {
    let dir = dir(app_data);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(id) = parse_id(file_name) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok();
        out.push((modified, CustomBackground {
            id,
            file_name: file_name.to_string(),
        }));
    }
    // Newest first so a just-uploaded swatch sits near the +.
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, bg)| bg).collect())
}

pub fn delete(app_data: &Path, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let dir = dir(app_data);
    // Only delete a matching allowlisted image — never rm arbitrary paths.
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let path = dir.join(format!("{id}.{ext}"));
        if path.is_file() {
            fs::remove_file(&path)?;
            return Ok(());
        }
    }
    Err(AppError::Other(format!("custom background not found: {id}")))
}

fn normalize_ext(raw: &str) -> AppResult<&'static str> {
    let e = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "webp" => Ok("webp"),
        _ => Err(AppError::Other(format!(
            "unsupported background type: {raw:?} (use jpg, png, or webp)"
        ))),
    }
}

fn validate_id(id: &str) -> AppResult<()> {
    let ok = id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(AppError::Other(format!("invalid background id: {id:?}")))
    }
}

fn parse_id(file_name: &str) -> Option<String> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    normalize_ext(ext).ok()?;
    validate_id(stem).ok()?;
    Some(stem.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-bg-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_list_delete_roundtrip() {
        let root = tmp_root();
        let a = save(&root, b"fake-png-bytes", "png").unwrap();
        assert_eq!(a.id.len(), 32);
        assert!(dir(&root).join(&a.file_name).is_file());

        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, a.id);

        delete(&root, &a.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_ext_and_oversized() {
        let root = tmp_root();
        assert!(save(&root, b"x", "gif").is_err());
        assert!(save(&root, b"x", "../png").is_err());
        let big = vec![0u8; MAX_BYTES + 1];
        assert!(save(&root, &big, "jpg").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_rejects_path_traversal_ids() {
        let root = tmp_root();
        assert!(delete(&root, "../etc").is_err());
        assert!(delete(&root, "abc").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_ignores_junk_and_orders_newest_first() {
        let root = tmp_root();
        let dir = dir(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("nope.txt"), b"x").unwrap();
        fs::write(dir.join("short.jpg"), b"x").unwrap();

        let older = save(&root, b"old", "jpg").unwrap();
        // Ensure distinct mtimes on filesystems with coarse resolution.
        std::thread::sleep(Duration::from_millis(20));
        let newer = save(&root, b"new", "png").unwrap();

        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, newer.id);
        assert_eq!(listed[1].id, older.id);
        let _ = SystemTime::now(); // silence unused on some targets
        let _ = fs::remove_dir_all(&root);
    }
}
