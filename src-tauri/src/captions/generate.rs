//! Extract audio → whisper.cpp → SRT/JSON (+ silence map for phrase segmentation in JS).

use crate::captions::types::{SilenceInterval, WhisperTranscriptArtifacts};
use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const SILENCE_NOISE_DB: &str = "-30";
const SILENCE_DETECT_MIN_S: &str = "0.5";

/// `project_dir` must come from `ProjectStore::project_dir`, which is what
/// validates the id it was built from — do not re-derive it by joining a raw
/// `project_id` onto the projects root.
pub fn generate(
    app: &AppHandle,
    project_dir: &Path,
    language: Option<&str>,
) -> AppResult<WhisperTranscriptArtifacts> {
    let screen = project_dir.join("screen.mp4");
    if !screen.is_file() {
        return Err(AppError::Other("screen recording not found".into()));
    }

    let model_path = crate::captions::model::model_path(app)?;
    if !model_path.is_file() {
        return Err(AppError::Other(
            "Whisper model not downloaded. Download it from the Captions panel first.".into(),
        ));
    }

    let whisper = resolve_whisper_executable()?;
    let ffmpeg = ffmpeg_path();
    let temp_base = std::env::temp_dir().join(format!(
        "capptivo-captions-{}",
        uuid::Uuid::new_v4()
    ));
    let wav = temp_base.with_extension("wav");
    let lang = language
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "auto")
        .unwrap_or("auto");

    let out_base = format!("{}-whisper", temp_base.to_string_lossy());
    let srt_path = PathBuf::from(format!("{out_base}.srt"));
    let json_path = PathBuf::from(format!("{out_base}.json"));

    let _ = app.emit(
        "captions://progress",
        serde_json::json!({ "phase": "extracting", "progress": 0 }),
    );

    extract_wav(&ffmpeg, &screen, &wav)?;

    let _ = app.emit(
        "captions://progress",
        serde_json::json!({ "phase": "transcribing", "progress": 10 }),
    );

    let model_path_str = model_path.to_string_lossy().into_owned();
    let wav_str = wav.to_string_lossy().into_owned();
    let base_args = [
        "-m",
        model_path_str.as_str(),
        "-f",
        wav_str.as_str(),
        "-osrt",
        "-of",
        out_base.as_str(),
        "-l",
        lang,
        "-np",
    ];

    let json_ok = match run_whisper(&whisper, base_args.iter().copied().chain(["-ojf"])) {
        Ok(()) => true,
        Err(e) if whisper_json_unsupported(&e) => {
            tracing::warn!(%e, "whisper JSON unsupported, retrying SRT-only");
            run_whisper(&whisper, base_args.iter().copied())?;
            false
        }
        Err(e) => return Err(e),
    };

    let srt = std::fs::read_to_string(&srt_path)
        .map_err(|e| AppError::Other(format!("read whisper srt: {e}")))?;
    let json = if json_ok && json_path.is_file() {
        Some(
            std::fs::read_to_string(&json_path)
                .map_err(|e| AppError::Other(format!("read whisper json: {e}")))?,
        )
    } else {
        None
    };

    let silences = detect_silence(&ffmpeg, &wav)?;

    let _ = app.emit(
        "captions://progress",
        serde_json::json!({ "phase": "done", "progress": 100 }),
    );

    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(&srt_path);
    let _ = std::fs::remove_file(&json_path);

    Ok(WhisperTranscriptArtifacts {
        srt,
        json,
        silences,
    })
}

fn extract_wav(ffmpeg: &Path, video: &Path, wav: &Path) -> AppResult<()> {
    // Caption generation is entirely background work: audio extract, then the
    // whisper model. None of it blocks the editor.
    let status = proc::background_command(ffmpeg)
        .args([
            "-y",
            "-i",
            &video.to_string_lossy(),
            "-map",
            "0:a:0?",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            &wav.to_string_lossy(),
        ])
        .status()
        .map_err(|e| AppError::Other(format!("ffmpeg spawn: {e}")))?;
    if !status.success() {
        return Err(AppError::Other(
            "Could not extract audio from the recording. Captions need an audio track.".into(),
        ));
    }
    Ok(())
}

fn run_whisper<'a>(
    whisper: &Path,
    args: impl IntoIterator<Item = &'a str>,
) -> AppResult<()> {
    // whisper.cpp caps itself at 4 threads by default, so it needs no --threads
    // argument here — only the priority demotion.
    let status = proc::background_command(whisper)
        .args(args)
        .status()
        .map_err(|e| AppError::Other(format!("whisper spawn ({whisper:?}): {e}")))?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "Whisper failed (exit {status}). {}",
            whisper_install_hint()
        )));
    }
    Ok(())
}

/// Per-OS guidance shown when no whisper.cpp binary can be found or run.
fn whisper_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install whisper.cpp (`brew install whisper-cpp`) or set WHISPER_CPP_PATH."
    } else if cfg!(target_os = "windows") {
        "Install whisper.cpp (`winget install whisper-cpp`, or download whisper-cli.exe from the whisper.cpp releases) and add it to PATH, or set WHISPER_CPP_PATH."
    } else {
        "Install whisper.cpp from your distro packages or the whisper.cpp releases, ensure `whisper-cli` is on PATH, or set WHISPER_CPP_PATH."
    }
}

fn whisper_json_unsupported(err: &AppError) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("unknown argument")
        || msg.contains("output-json")
        || msg.contains("ojf")
        || msg.contains("oj ")
}

fn detect_silence(ffmpeg: &Path, wav: &Path) -> AppResult<Vec<SilenceInterval>> {
    let output = proc::background_command(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-i",
            &wav.to_string_lossy(),
            "-af",
            &format!("silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_DETECT_MIN_S}"),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| AppError::Other(format!("silencedetect spawn: {e}")))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_silence_stderr(&stderr))
}

fn parse_silence_stderr(stderr: &str) -> Vec<SilenceInterval> {
    let mut intervals = Vec::new();
    let mut pending_start: Option<u64> = None;

    for line in stderr.lines() {
        if let Some(cap) = line
            .split("silence_start:")
            .nth(1)
            .and_then(|s| s.trim().split_whitespace().next())
        {
            if let Ok(secs) = cap.parse::<f64>() {
                pending_start = Some((secs.max(0.0) * 1000.0).round() as u64);
            }
            continue;
        }
        if let Some(cap) = line
            .split("silence_end:")
            .nth(1)
            .and_then(|s| s.trim().split_whitespace().next())
        {
            if let (Some(start), Ok(secs)) = (pending_start, cap.parse::<f64>()) {
                let end = (secs * 1000.0).round() as u64;
                if end > start {
                    intervals.push(SilenceInterval {
                        start_ms: start,
                        end_ms: end,
                    });
                }
                pending_start = None;
            }
        }
    }

    if let Some(start) = pending_start {
        intervals.push(SilenceInterval {
            start_ms: start,
            end_ms: u64::MAX,
        });
    }

    intervals.sort_by_key(|i| i.start_ms);
    intervals
}

/// Binary names whisper.cpp ships under, in preference order.
const WHISPER_NAMES: &[&str] = &["whisper-cli", "whisper-cpp", "whisper", "main"];

pub fn resolve_whisper_executable() -> AppResult<PathBuf> {
    // 1. Explicit override always wins.
    if let Ok(p) = std::env::var("WHISPER_CPP_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    // 2. Well-known per-OS install locations that may not be on PATH.
    for dir in well_known_dirs() {
        for name in WHISPER_NAMES {
            let candidate = dir.join(proc::exe_name(name));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 3. PATH walk (replaces shelling out to `which`, which Windows lacks).
    if let Some(found) = proc::find_in_path(WHISPER_NAMES) {
        return Ok(found);
    }

    Err(AppError::Other(format!(
        "No whisper.cpp binary found. {}",
        whisper_install_hint()
    )))
}

fn well_known_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = Vec::new();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs").join("whisper-cpp"));
        }
        dirs
    }
    #[cfg(target_os = "linux")]
    {
        let mut dirs = vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local").join("bin"));
        }
        dirs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_silence_lines() {
        let stderr = r#"
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 0.5
"#;
        let v = parse_silence_stderr(stderr);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].start_ms, 1500);
        assert_eq!(v[0].end_ms, 2000);
    }
}
