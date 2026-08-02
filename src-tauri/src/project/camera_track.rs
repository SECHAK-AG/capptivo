//! Face-cam track normalization.
//!
//! The camera bubble records through `MediaRecorder`, which on every platform we
//! ship picks VP9-in-WebM. That file is a *live* mux: no Duration element, no
//! Cues, no seek index — `ffprobe` reports `Duration: N/A`. Two things break in
//! the editor because of it:
//!
//! - Every timing guard on the face-cam is written as
//!   `Number.isFinite(duration) && duration > 0`. A duration-less file reports
//!   `Infinity`, so the face-cam is never seeked, never synced to the timeline,
//!   and its decoder is never woken while the preview is paused.
//! - WKWebView plays WebM/VP9 through a different media engine than MP4/H.264,
//!   and that engine does not reliably hand decoded pixels to `texImage2D`. The
//!   screen track uploads fine on the very same composed frame while the
//!   face-cam uploads black — a face-cam shadow with a black box inside it.
//!
//! Export never showed the bug because it decodes the camera with WebCodecs
//! (`export/sequentialMedia.ts`), bypassing the `<video>` media engine — so the
//! defect also drifted preview away from export.
//!
//! Normalizing to the same faststart H.264 MP4 the rest of the pipeline already
//! uses puts the face-cam on the exact code path the screen track proves works.
//! Presentation timestamps pass through untouched, so a normalized track is
//! frame-for-frame the same timeline as the WebM it replaces.

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use crate::recorder::hw_encoder;
use std::path::{Path, PathBuf};

/// What `MediaRecorder` writes during capture.
pub const CAMERA_WEBM: &str = "camera.webm";
/// The normalized track — what the editor and export both read.
pub const CAMERA_MP4: &str = "camera.mp4";

/// Under this a face-cam file is an empty `MediaRecorder` stub, not a recording.
const MIN_USABLE_BYTES: u64 = 2048;

/// Generous for a webcam at any resolution we can be handed, and the face-cam
/// is re-encoded exactly once per project.
const CAMERA_BITRATE: &str = "5000k";

/// Whether `path` holds real captured bytes rather than an empty stub.
pub fn is_usable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > MIN_USABLE_BYTES)
        .unwrap_or(false)
}

/// The face-cam file already on disk for `dir`, preferring the normalized track.
/// `None` when the project has no face-cam.
pub fn resolve(dir: &Path) -> Option<&'static str> {
    if is_usable(&dir.join(CAMERA_MP4)) {
        Some(CAMERA_MP4)
    } else if is_usable(&dir.join(CAMERA_WEBM)) {
        Some(CAMERA_WEBM)
    } else {
        None
    }
}

/// Ensure `dir` holds a normalized face-cam track, transcoding the recorded
/// WebM once if needed. Returns the filename the editor should play, or `None`
/// when the project has no face-cam at all.
///
/// The recorded WebM is left in place: the transcode is lossy, and it is the
/// original capture.
pub fn ensure(dir: &Path) -> AppResult<Option<&'static str>> {
    let mp4 = dir.join(CAMERA_MP4);
    if is_usable(&mp4) {
        return Ok(Some(CAMERA_MP4));
    }

    let webm = dir.join(CAMERA_WEBM);
    if !is_usable(&webm) {
        return Ok(None);
    }

    transcode(&webm, &mp4)?;
    Ok(Some(CAMERA_MP4))
}

/// Temp sidecar for an atomic swap — a half-written `camera.mp4` would be
/// picked up by `resolve` on the next open and play as a truncated face-cam.
fn temp_path(out: &Path) -> PathBuf {
    out.with_extension("tmp.mp4")
}

fn transcode(src: &Path, out: &Path) -> AppResult<()> {
    let tmp = temp_path(out);
    let ffmpeg = ffmpeg_path();
    let encoder = hw_encoder::pick(&ffmpeg);

    let status = proc::command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
        .args(encoder.pre_input_args)
        .arg("-i")
        .arg(src)
        // The face-cam track carries no audio the editor uses — the mic is
        // recorded separately and muxed by the export path.
        .arg("-an")
        .args(["-c:v", encoder.name])
        .args(encoder.output_args(None))
        .args(encoder.tuning_args)
        .args([
            "-b:v",
            CAMERA_BITRATE,
            // Keep the capture's own presentation timestamps. The bubble records
            // at a variable rate; resampling to CFR here would slide the face-cam
            // against the screen track and split preview from export.
            "-fps_mode",
            "passthrough",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+faststart",
        ])
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Other(format!("camera track ffmpeg spawn failed: {e}")))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Other(format!(
            "camera track transcode failed with {status}"
        )));
    }

    if !is_usable(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Other(
            "camera track transcode produced no frames".into(),
        ));
    }

    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Other(format!("camera track rename failed: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-camera-{}-{}-{name}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_bytes(path: &Path, len: usize) {
        std::fs::write(path, vec![0u8; len]).unwrap();
    }

    #[test]
    fn stubs_are_not_usable() {
        let dir = scratch("stub");
        let file = dir.join(CAMERA_WEBM);
        write_bytes(&file, 512);
        assert!(!is_usable(&file));
        assert_eq!(resolve(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_prefers_the_normalized_track() {
        let dir = scratch("prefer");
        write_bytes(&dir.join(CAMERA_WEBM), 8192);
        assert_eq!(resolve(&dir), Some(CAMERA_WEBM));
        write_bytes(&dir.join(CAMERA_MP4), 8192);
        assert_eq!(resolve(&dir), Some(CAMERA_MP4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_is_a_no_op_without_a_face_cam() {
        let dir = scratch("none");
        assert_eq!(ensure(&dir).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_skips_an_existing_normalized_track() {
        let dir = scratch("cached");
        write_bytes(&dir.join(CAMERA_WEBM), 8192);
        // Not decodable — a transcode attempt would fail, so reaching `Ok` here
        // proves the existing track short-circuited before FFmpeg ran.
        write_bytes(&dir.join(CAMERA_MP4), 8192);
        assert_eq!(ensure(&dir).unwrap(), Some(CAMERA_MP4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn temp_sidecar_sits_beside_the_output() {
        let out = Path::new("/tmp/p/camera.mp4");
        assert_eq!(temp_path(out), PathBuf::from("/tmp/p/camera.tmp.mp4"));
    }

    fn ffmpeg_available() -> bool {
        proc::command(ffmpeg_path())
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    /// The whole point of normalization: same frames, same timestamps, but in a
    /// container that declares a duration. A drift here would slide the face-cam
    /// against the screen track and split preview from export.
    #[test]
    fn normalizing_preserves_every_frame_timestamp() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not found — skipping camera normalization test");
            return;
        }

        let dir = scratch("roundtrip");
        let webm = dir.join(CAMERA_WEBM);
        // A live-muxed WebM with no Duration element — what MediaRecorder writes.
        let status = proc::command(ffmpeg_path())
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=15:duration=2",
            ])
            .args(["-c:v", "libvpx-vp9", "-b:v", "300k", "-speed", "8"])
            .args(["-f", "webm", "-live", "1"])
            .arg(&webm)
            .status()
            .unwrap();
        if !status.success() {
            eprintln!("no VP9 encoder — skipping camera normalization test");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        assert_eq!(ensure(&dir).unwrap(), Some(CAMERA_MP4));

        let before = frame_timestamps(&webm);
        let after = frame_timestamps(&dir.join(CAMERA_MP4));
        assert!(!before.is_empty(), "fixture decoded no frames");
        assert_eq!(before.len(), after.len(), "frame count must be preserved");
        // WebM counts in milliseconds and MP4 in 1/90000s, so the two grids do
        // not land on identical rationals. Anything past a tick of rounding
        // means FFmpeg resampled the track to CFR — which is exactly the drift
        // `-fps_mode passthrough` exists to prevent.
        for (i, (b, a)) in before.iter().zip(&after).enumerate() {
            assert!(
                (b - a).abs() < 0.002,
                "frame {i} moved {}s ({b} → {a})",
                (b - a).abs()
            );
        }

        // The recorded original is never destroyed by the pass.
        assert!(is_usable(&webm));
        // A second call is served from disk rather than re-encoding.
        assert_eq!(ensure(&dir).unwrap(), Some(CAMERA_MP4));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn frame_timestamps(path: &Path) -> Vec<f64> {
        let out = proc::command(crate::recorder::encoder::ffprobe_path())
            .args(["-v", "error", "-select_streams", "v:0"])
            .args(["-show_entries", "frame=pts_time", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').parse::<f64>().ok())
            .collect()
    }
}
