//! The native export folder preference is shared across projects and app launches.
use std::path::{Path, PathBuf};
const FILE: &str = "export-folder.json";

pub fn load(root: &Path) -> Option<PathBuf> {
    let path: PathBuf = serde_json::from_slice(&std::fs::read(root.join(FILE)).ok()?).ok()?;
    path.is_dir().then_some(path)
}

pub fn save(root: &Path, folder: &Path) -> std::io::Result<()> {
    if !folder.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "Export folder does not exist"));
    }
    std::fs::create_dir_all(root)?;
    let data = serde_json::to_vec(folder).map_err(std::io::Error::other)?;
    let temp = root.join(format!("export-folder-{}.tmp", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    std::fs::write(&temp, data)?;
    let result = std::fs::rename(&temp, root.join(FILE));
    if result.is_err() { let _ = std::fs::remove_file(temp); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_survives_reload_and_can_be_changed() {
        let root = std::env::temp_dir().join(format!("capptivo-folder-test-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let first = root.join("first"); let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap(); std::fs::create_dir_all(&second).unwrap();
        assert!(load(&root).is_none());
        save(&root, &first).unwrap(); assert_eq!(load(&root), Some(first));
        save(&root, &second).unwrap(); assert_eq!(load(&root), Some(second.clone()));
        std::fs::remove_dir(second).unwrap(); assert!(load(&root).is_none());
        assert!(save(&root, &root.join("missing")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
