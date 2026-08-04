//! Child-process helpers shared by every sidecar spawn (FFmpeg, ffprobe,
//! whisper.cpp).
//!
//! Centralized so platform quirks live in exactly one place:
//! - Windows: `CREATE_NO_WINDOW`, or every spawn flashes a console window.
//! - Windows: sidecar binaries carry an `.exe` suffix.
//! - Linux packages: sidecars are namespaced (`capptivo-ffmpeg`) so they do
//!   not collide with system `/usr/bin/ffmpeg` when Tauri installs them
//!   beside the app binary.

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
/// (Tauri `externalBin` drops it there), then the first of `path_fallbacks`
/// found on `$PATH`, else the first fallback as a bare name for `Command`.
pub fn sidecar_or_path(sidecar: &str, path_fallbacks: &[&str]) -> PathBuf {
    let name = exe_name(sidecar);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let path = dir.join(&name);
            if path.is_file() {
                return path;
            }
        }
    }
    find_in_path(path_fallbacks).unwrap_or_else(|| {
        PathBuf::from(exe_name(
            path_fallbacks.first().copied().unwrap_or(sidecar),
        ))
    })
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

/// Longest sidecar diagnostic we will put in a log line.
pub const STDERR_SUMMARY_CAP: usize = 256;

/// Flatten a sidecar's stderr to one bounded line.
///
/// This ends up in a log file on the user's disk, and FFmpeg is happy to emit
/// dozens of lines for one failure. Truncation counts `char`s rather than bytes
/// so a multi-byte sequence is never split.
pub fn summarize_stderr(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let flat = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    if flat.chars().count() <= STDERR_SUMMARY_CAP {
        return flat;
    }
    flat.chars()
        .take(STDERR_SUMMARY_CAP)
        .chain(std::iter::once('…'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_or_path_falls_back_to_bare_ffmpeg_name() {
        // When the namespaced sidecar isn't next to the test binary, resolve
        // via PATH / bare `ffmpeg` — never return the missing sidecar stem.
        let got = sidecar_or_path(
            "capptivo-ffmpeg-definitely-not-bundled-for-test",
            &["ffmpeg"],
        );
        let name = got.file_name().and_then(|s| s.to_str()).unwrap_or("");
        assert!(
            name == exe_name("ffmpeg") || name.ends_with(&exe_name("ffmpeg")),
            "unexpected fallback: {got:?}"
        );
    }

    #[test]
    fn stderr_summary_is_one_bounded_line() {
        let noisy = "a rejection reason\n\nand another line\n".repeat(200);
        let summary = summarize_stderr(noisy.as_bytes());
        assert!(!summary.contains('\n'), "must collapse to one line");
        assert!(
            summary.chars().count() <= STDERR_SUMMARY_CAP + 1,
            "must stay bounded, got {} chars",
            summary.chars().count()
        );
    }

    #[test]
    fn stderr_summary_does_not_split_multibyte_characters() {
        // Truncation counts chars, so a long run of 3-byte characters must come
        // back as valid UTF-8 rather than a replacement-char smear.
        let wide = "日".repeat(STDERR_SUMMARY_CAP * 2);
        let summary = summarize_stderr(wide.as_bytes());
        assert!(!summary.contains('\u{FFFD}'), "must not split a character");
    }
}

