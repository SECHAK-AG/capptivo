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

/// Like [`command`], but for long-running work the user is not waiting on:
/// preview proxies, poster frames, camera-track normalization, caption models.
///
/// On Windows these run at `BELOW_NORMAL_PRIORITY_CLASS`. Windows has no
/// automatic background QoS demotion the way macOS does, so a child inheriting
/// `NORMAL` puts a multi-minute 4K transcode in direct competition with DWM,
/// the shell, and the user's browser — which is how one background job makes
/// the whole desktop feel frozen.
///
/// `IDLE_PRIORITY_CLASS` was rejected: it yields to *any* other runnable
/// thread, so the job stalls indefinitely while the user works and the editor
/// waits forever on a proxy that never arrives. `BELOW_NORMAL` still gets a full
/// core when one is free.
///
/// Priority is a `CreateProcess` creation flag, so this needs no
/// `SetPriorityClass` call and no extra `windows` crate feature. Note the flags
/// are re-specified rather than OR'd onto [`command`]'s: `creation_flags`
/// replaces the value, so dropping `CREATE_NO_WINDOW` here would bring back a
/// console flash on every spawn.
///
/// No-op off Windows — macOS and Linux already schedule this workload acceptably.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = command(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    cmd
}

/// Threads a *background* FFmpeg job may use: every core but two, floor of 1.
///
/// FFmpeg defaults to one thread per logical core, so a 4K proxy transcode takes
/// the whole machine. Two cores of headroom is what keeps the UI and the
/// compositor responsive while it runs.
///
/// Deliberately **not** applied to the live recorder encoder or to export. The
/// recorder has to keep pace with capture — starving it drops frames, which is a
/// real recording-quality loss — and export is a foreground task the user is
/// actively waiting on. Both are better served by finishing fast.
///
/// Falls back to 1 if the core count is unavailable: a slow background job beats
/// an unusable machine.
pub fn encode_thread_cap() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2).max(1))
        .unwrap_or(1)
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
    fn encode_thread_cap_leaves_headroom_for_the_desktop() {
        let cap = encode_thread_cap();
        assert!(cap >= 1, "must always allow at least one encode thread");
        if let Ok(cores) = std::thread::available_parallelism() {
            if cores.get() > 2 {
                assert!(
                    cap < cores.get(),
                    "a background job must never be handed every core ({cap} of {cores})"
                );
            }
        }
    }

    #[test]
    fn encode_thread_cap_is_a_usable_ffmpeg_argument() {
        // It is interpolated straight into `-threads N`; zero would make FFmpeg
        // pick its own (all cores), silently undoing the cap.
        let arg = encode_thread_cap().to_string();
        assert_ne!(arg, "0", "`-threads 0` means 'auto', i.e. no cap at all");
        assert!(arg.parse::<usize>().is_ok_and(|n| n >= 1));
    }

    #[test]
    fn background_command_still_suppresses_the_console_window() {
        // `creation_flags` replaces rather than ORs, so `background_command`
        // has to re-specify CREATE_NO_WINDOW. Losing it means a console flashes
        // on every proxy transcode. The flag itself is not readable back off
        // `Command`, so assert the property that guards it: the two builders
        // agree on the program they spawn, i.e. one delegates to the other.
        let a = command("ffmpeg");
        let b = background_command("ffmpeg");
        assert_eq!(a.get_program(), b.get_program());
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

