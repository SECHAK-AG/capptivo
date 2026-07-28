//! Child-process helpers shared by every sidecar spawn (FFmpeg, ffprobe,
//! whisper.cpp).
//!
//! Centralized so platform quirks live in exactly one place:
//! - Windows: `CREATE_NO_WINDOW`, or every spawn flashes a console window.
//! - Windows: sidecar binaries carry an `.exe` suffix.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Build a [`Command`] with the platform-correct spawn flags applied.
/// All sidecar invocations must go through this instead of `Command::new`.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Append the platform executable suffix to a bare tool name (`ffmpeg` →
/// `ffmpeg.exe` on Windows).
pub fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Resolve a sidecar tool: prefer a copy bundled next to the app executable
/// (Tauri `externalBin` drops it there), fall back to `$PATH`.
pub fn sidecar_or_path(base: &str) -> PathBuf {
    let name = exe_name(base);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(&name);
            if sidecar.exists() {
                return sidecar;
            }
        }
    }
    PathBuf::from(name)
}

/// Walk `$PATH` for the first existing candidate among `names`.
/// Replacement for shelling out to `which`/`where` — deterministic on all OSes.
pub fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(exe_name(name));
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}
