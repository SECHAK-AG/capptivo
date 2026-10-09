//! What a video file contains: size, colour, and every frame's timestamp.
//!
//! Frame timestamps come from a packet scan (demux only, no decode), so they
//! are exact and cheap. The decoder maps the n-th decoded frame onto the n-th
//! presentation timestamp — valid because FFmpeg emits one frame per kept
//! packet, in presentation order, with `-fps_mode passthrough`.

use std::path::Path;

use serde::Deserialize;

use crate::error::{EngineError, Result};
use crate::media::process::run_capture;

/// How the file's YCbCr maps to RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YuvMatrix {
    Bt601,
    Bt709,
    Bt2020,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorInfo {
    pub matrix: YuvMatrix,
    /// Full (0–255) vs limited (16–235) range.
    pub full_range: bool,
}

/// One video stream, probed.
#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub color: ColorInfo,
    /// Presentation time of every frame, ascending, in container seconds.
    pub frame_times: Vec<f64>,
    /// Indices into `frame_times` of the frames a decode can start from.
    pub keyframes: Vec<usize>,
    /// Container start time; `-ss` positions are relative to it.
    pub start_time: f64,
    pub duration: f64,
}

impl MediaInfo {
    /// The frame shown at `time`: the last one presented at or before it, or
    /// the first frame for times before the stream starts.
    pub fn frame_index_at(&self, time: f64) -> usize {
        self.frame_times
            .partition_point(|&t| t <= time)
            .saturating_sub(1)
    }

    /// The decode entry point for `index`: the last keyframe at or before it.
    pub fn keyframe_at_or_before(&self, index: usize) -> usize {
        let count = self.keyframes.partition_point(|&k| k <= index);
        count.checked_sub(1).map_or(0, |i| self.keyframes[i])
    }

    /// Bytes in one tightly packed NV12 frame.
    pub fn nv12_frame_len(&self) -> usize {
        nv12_len(self.width, self.height)
    }
}

pub fn nv12_len(width: u32, height: u32) -> usize {
    let (w, h) = (width as usize, height as usize);
    w * h + w * (h / 2)
}

#[derive(Deserialize)]
struct ProbeJson {
    #[serde(default)]
    streams: Vec<StreamJson>,
    format: Option<FormatJson>,
}

#[derive(Deserialize)]
struct StreamJson {
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    color_space: Option<String>,
    color_range: Option<String>,
}

#[derive(Deserialize)]
struct FormatJson {
    start_time: Option<String>,
    duration: Option<String>,
}

/// Probe `path` with the bundled `ffprobe`.
pub fn probe(ffprobe: &Path, path: &Path) -> Result<MediaInfo> {
    let path_arg = path.as_os_str();
    let json = run_capture(
        ffprobe,
        &[
            "-v".as_ref(),
            "error".as_ref(),
            "-select_streams".as_ref(),
            "v:0".as_ref(),
            "-show_entries".as_ref(),
            "stream=width,height,pix_fmt,color_space,color_range:format=start_time,duration"
                .as_ref(),
            "-of".as_ref(),
            "json".as_ref(),
            path_arg,
        ],
    )?;
    let parsed: ProbeJson = serde_json::from_slice(&json)
        .map_err(|e| EngineError::media(path, format!("unreadable probe output: {e}")))?;
    let stream = parsed
        .streams
        .into_iter()
        .next()
        .ok_or_else(|| EngineError::media(path, "no video stream"))?;
    let (width, height) = match (stream.width, stream.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => return Err(EngineError::media(path, "video stream has no size")),
    };
    if width % 2 != 0 || height % 2 != 0 {
        return Err(EngineError::media(
            path,
            format!("odd frame size {width}x{height} cannot be decoded to NV12"),
        ));
    }
    let format = parsed.format;
    let parse_time = |v: Option<&String>| {
        v.and_then(|s| s.parse::<f64>().ok())
            .filter(|t| t.is_finite())
    };
    let start_time = parse_time(format.as_ref().and_then(|f| f.start_time.as_ref())).unwrap_or(0.0);
    let duration = parse_time(format.as_ref().and_then(|f| f.duration.as_ref())).unwrap_or(0.0);

    let color = color_info(
        width,
        height,
        stream.pix_fmt.as_deref(),
        stream.color_space.as_deref(),
        stream.color_range.as_deref(),
    );

    let packets = run_capture(
        ffprobe,
        &[
            "-v".as_ref(),
            "error".as_ref(),
            "-select_streams".as_ref(),
            "v:0".as_ref(),
            "-show_entries".as_ref(),
            "packet=pts_time,flags".as_ref(),
            "-of".as_ref(),
            "csv=p=0".as_ref(),
            path_arg,
        ],
    )?;
    let (frame_times, keyframes) = parse_packets(&String::from_utf8_lossy(&packets));
    if frame_times.is_empty() {
        return Err(EngineError::media(path, "video stream has no frames"));
    }
    // MediaRecorder WebMs carry no duration; the last frame's end is the
    // duration a player would report.
    let duration = if duration > 0.0 {
        duration
    } else {
        stream_end(&frame_times) - start_time
    };
    Ok(MediaInfo {
        width,
        height,
        color,
        frame_times,
        keyframes,
        start_time,
        duration,
    })
}

/// Tagged streams use their tag. Untagged streams are read the way every
/// player the user previews in reads them — AVFoundation/WebKit, Chromium
/// (WebView2) and mpv all assume BT.709 for HD and BT.601 for SD — so the
/// export shows the colours the editor showed.
///
/// (Capptivo's recorder currently writes BT.601 data untagged, so that shared
/// assumption over-saturates slightly; the fix belongs in the recorder, which
/// should tag what it writes. Changing it here alone would only make export
/// and preview disagree.)
fn color_info(
    width: u32,
    height: u32,
    pix_fmt: Option<&str>,
    color_space: Option<&str>,
    color_range: Option<&str>,
) -> ColorInfo {
    let matrix = match color_space {
        Some("bt709") => YuvMatrix::Bt709,
        Some("bt2020nc" | "bt2020c") => YuvMatrix::Bt2020,
        Some("smpte170m" | "bt470bg" | "fcc") => YuvMatrix::Bt601,
        _ if width >= 1280 || height > 576 => YuvMatrix::Bt709,
        _ => YuvMatrix::Bt601,
    };
    let full_range = color_range == Some("pc") || pix_fmt.is_some_and(|p| p.starts_with("yuvj"));
    ColorInfo { matrix, full_range }
}

/// Presentation end of the last frame: its start plus the typical interval.
fn stream_end(times: &[f64]) -> f64 {
    let last = times[times.len() - 1];
    let tail = &times[times.len().saturating_sub(31)..];
    let interval = if tail.len() > 1 {
        (tail[tail.len() - 1] - tail[0]) / (tail.len() - 1) as f64
    } else {
        0.0
    };
    last + interval
}

/// `pts_time,flags` CSV → presentation-ordered times and keyframe indices.
/// Packets flagged `D` (discarded by an edit list) never become frames.
fn parse_packets(csv: &str) -> (Vec<f64>, Vec<usize>) {
    let mut packets: Vec<(f64, bool)> = csv
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().split(',');
            let time = fields
                .next()?
                .parse::<f64>()
                .ok()
                .filter(|t| t.is_finite())?;
            let flags = fields.next().unwrap_or("");
            (!flags.contains('D')).then_some((time, flags.contains('K')))
        })
        .collect();
    packets.sort_by(|a, b| a.0.total_cmp(&b.0));
    let times = packets.iter().map(|p| p.0).collect();
    let mut keyframes: Vec<usize> = packets
        .iter()
        .enumerate()
        .filter(|(_, p)| p.1)
        .map(|(i, _)| i)
        .collect();
    if keyframes.first() != Some(&0) {
        // A stream must be decodable from its first frame.
        keyframes.insert(0, 0);
    }
    (times, keyframes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_sort_into_presentation_order_and_drop_discards() {
        let (times, keys) = parse_packets(
            "0.000000,K__\n0.066000,___\n0.033000,___\n-0.033000,_D_\n0.100000,K__\n",
        );
        assert_eq!(times, vec![0.0, 0.033, 0.066, 0.1]);
        assert_eq!(keys, vec![0, 3]);
    }

    #[test]
    fn frame_lookup_takes_the_frame_on_screen() {
        let info = MediaInfo {
            width: 2,
            height: 2,
            color: color_info(2, 2, None, None, None),
            frame_times: vec![0.0, 0.1, 0.2],
            keyframes: vec![0, 2],
            start_time: 0.0,
            duration: 0.3,
        };
        assert_eq!(info.frame_index_at(-1.0), 0);
        assert_eq!(info.frame_index_at(0.05), 0);
        assert_eq!(info.frame_index_at(0.1), 1);
        assert_eq!(info.frame_index_at(9.0), 2);
        assert_eq!(info.keyframe_at_or_before(1), 0);
        assert_eq!(info.keyframe_at_or_before(2), 2);
    }

    #[test]
    fn duration_falls_back_to_the_last_frame_end() {
        let times: Vec<f64> = (0..10).map(|i| f64::from(i) / 30.0).collect();
        assert!((stream_end(&times) - 10.0 / 30.0).abs() < 1e-12);
        assert_eq!(stream_end(&[2.0]), 2.0);
    }

    #[test]
    fn untagged_streams_follow_the_players_hd_rule() {
        let c = color_info(3024, 1964, Some("yuv420p"), Some("unknown"), None);
        assert_eq!(c.matrix, YuvMatrix::Bt709);
        assert!(!c.full_range);
        let c = color_info(640, 480, Some("yuv420p"), None, None);
        assert_eq!(c.matrix, YuvMatrix::Bt601);
        let c = color_info(1920, 1080, Some("yuv420p"), Some("smpte170m"), None);
        assert_eq!(c.matrix, YuvMatrix::Bt601, "a tag always wins");
        let c = color_info(1280, 720, Some("yuvj420p"), Some("bt709"), None);
        assert_eq!(c.matrix, YuvMatrix::Bt709);
        assert!(c.full_range);
    }
}
