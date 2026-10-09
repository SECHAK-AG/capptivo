//! Reading a project folder straight from disk.
//!
//! The app hands the engine the editor's own snapshot; this loader exists for
//! the headless CLI (benchmarks, golden renders) and mirrors what the editor
//! does when it opens a project: `cursor.json` → [`RecordingMetadata`] exactly
//! like `windows/editor/lib/cursorLoad.ts`, `project.json`'s `editorState`
//! with the editor's defaults for anything missing.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::document::{
    CursorClickSample, CursorSample, CursorShape, PressInterval, RecordingMetadata, RenderDocument,
    Size,
};
use crate::error::{EngineError, Result};

/// Shape runs shorter than this are sensor glitches (`MIN_SHAPE_RUN_S`).
const MIN_SHAPE_RUN_S: f64 = 0.16;

#[derive(Deserialize)]
struct TrackJson {
    #[serde(default)]
    samples: Vec<SampleJson>,
    #[serde(rename = "captureRect")]
    capture_rect: Option<RectJson>,
}

#[derive(Deserialize)]
struct SampleJson {
    #[serde(default)]
    t: Option<f64>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    shape: Option<String>,
}

#[derive(Deserialize)]
struct RectJson {
    width: Option<f64>,
    height: Option<f64>,
}

/// `Number(v) || 0`.
fn or_zero(v: Option<f64>) -> f64 {
    v.filter(|n| n.is_finite()).unwrap_or(0.0)
}

/// `cursor.json` → the track the overlay and zoom use (`loadRecordingMetadata`).
pub fn recording_metadata_from_cursor_json(
    json: &[u8],
    source_size: Option<Size>,
) -> Result<Option<RecordingMetadata>> {
    let track: TrackJson = serde_json::from_slice(json)
        .map_err(|e| EngineError::Document(format!("cursor.json: {e}")))?;
    if track.samples.is_empty() {
        return Ok(None);
    }
    let mut samples: Vec<CursorSample> = track
        .samples
        .iter()
        .map(|s| CursorSample {
            t: or_zero(s.t),
            x: or_zero(s.x),
            y: or_zero(s.y),
            shape: s.shape.as_ref().and_then(|raw| {
                serde_json::from_value::<CursorShape>(Value::String(raw.clone())).ok()
            }),
        })
        .collect();
    suppress_shape_blips(&mut samples);

    let clicks = track
        .samples
        .iter()
        .filter(|s| s.kind.as_deref() == Some("down"))
        .map(|s| CursorClickSample {
            t: or_zero(s.t),
            x: or_zero(s.x),
            y: or_zero(s.y),
        })
        .collect();

    let mut press: Vec<PressInterval> = Vec::new();
    for s in &track.samples {
        let t = or_zero(s.t);
        match s.kind.as_deref() {
            Some("down") => press.push(PressInterval {
                start: t,
                end: f64::INFINITY,
            }),
            Some("up") => {
                if let Some(open) = press.last_mut() {
                    if !open.end.is_finite() {
                        open.end = t;
                    }
                }
            }
            _ => {}
        }
    }

    let capture = track.capture_rect.as_ref();
    Ok(Some(RecordingMetadata {
        source_width: source_size
            .map(|s| s.width)
            .or_else(|| capture.and_then(|c| c.width))
            .unwrap_or(1920.0),
        source_height: source_size
            .map(|s| s.height)
            .or_else(|| capture.and_then(|c| c.height))
            .unwrap_or(1080.0),
        cursor_samples: samples,
        cursor_click_samples: clicks,
        cursor_press_intervals: press,
    }))
}

/// Collapse A→B→A shape blips shorter than [`MIN_SHAPE_RUN_S`]
/// (`suppressShapeBlips`).
fn suppress_shape_blips(samples: &mut [CursorSample]) {
    if samples.len() < 3 {
        return;
    }
    let mut run_starts = vec![0usize];
    for i in 1..samples.len() {
        if samples[i].shape != samples[i - 1].shape {
            run_starts.push(i);
        }
    }
    if run_starts.len() < 3 {
        return;
    }
    for r in 1..run_starts.len() - 1 {
        let start = run_starts[r];
        let next = run_starts[r + 1];
        let duration = samples[next].t - samples[start].t;
        let before = samples[start - 1].shape;
        let after = samples[next].shape;
        if duration < MIN_SHAPE_RUN_S && before == after {
            for sample in &mut samples[start..next] {
                sample.shape = before;
            }
        }
    }
}

/// A project as the editor would render it.
#[derive(Debug, Clone)]
pub struct LoadedProject {
    pub dir: PathBuf,
    pub document: RenderDocument,
    pub screen: PathBuf,
    pub camera: Option<PathBuf>,
    /// `public/background-images/<file>` when an image preset is selected.
    pub background_preset: Option<String>,
}

/// Load `project.json` + `meta.json` + `cursor.json` from `dir`.
///
/// `source_size` is the decoded screen size (the editor uses the decoded
/// video's size, not the capture rect).
pub fn load_project(dir: &Path, source_size: Size, duration: f64) -> Result<LoadedProject> {
    let read_json = |name: &str| -> Result<Value> {
        let path = dir.join(name);
        let bytes = std::fs::read(&path).map_err(|e| EngineError::media(&path, e.to_string()))?;
        serde_json::from_slice(&bytes).map_err(|e| EngineError::Document(format!("{name}: {e}")))
    };
    let project = read_json("project.json")?;
    let meta = read_json("meta.json").unwrap_or(Value::Null);
    let state = project.get("editorState").cloned().unwrap_or(Value::Null);

    let mut doc = serde_json::json!({
        "sourceVideoSize": {"width": source_size.width, "height": source_size.height},
        "sourceAspect": source_size.width / source_size.height,
        "duration": duration,
    });
    for key in [
        "aspectRatioPresetId",
        "look",
        "screenContentCrop",
        "segments",
        "zoomFragments",
        "blurRegions",
        "cursorSettings",
        "faceCam",
        "captions",
        "captionSettings",
    ] {
        if let Some(v) = state.get(key).filter(|v| !v.is_null()) {
            doc[key] = v.clone();
        }
    }
    let background = state.get("background");
    let background_type = background
        .and_then(|b| b.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("image");
    doc["backgroundType"] = Value::String(background_type.to_string());
    // The editor forces 16:9 when an image background meets "Match".
    if background_type == "image"
        && doc
            .get("aspectRatioPresetId")
            .and_then(Value::as_str)
            .unwrap_or("recording")
            == "recording"
    {
        doc["aspectRatioPresetId"] = Value::String("16:9".into());
    }
    if let Some(offset) = meta.get("cameraOffsetMs").and_then(Value::as_f64) {
        doc["cameraOffsetMs"] = offset.into();
    }
    let mut document: RenderDocument = serde_json::from_value(doc)
        .map_err(|e| EngineError::Document(format!("editorState: {e}")))?;

    if let Ok(cursor) = std::fs::read(dir.join("cursor.json")) {
        document.recording_metadata =
            recording_metadata_from_cursor_json(&cursor, Some(source_size))?;
    }

    let background_preset = background.and_then(|b| {
        let preset = b.get("presetId")?.as_str()?;
        (b.get("selection")?.as_str()? == "preset")
            .then(|| preset.strip_prefix("img-").map(str::to_string))
            .flatten()
    });

    let files = project.get("files");
    let file = |key: &str| {
        files
            .and_then(|f| f.get(key))
            .and_then(Value::as_str)
            .map(|f| dir.join(f))
    };
    let screen = file("screen").unwrap_or_else(|| dir.join("screen.mp4"));
    // The editor plays the normalized H.264 camera track when it exists.
    let camera = [dir.join("camera.mp4")]
        .into_iter()
        .chain(file("camera"))
        .find(|p| p.is_file());

    Ok(LoadedProject {
        dir: dir.to_path_buf(),
        document,
        screen,
        camera,
        background_preset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_track_pairs_presses_and_suppresses_blips() {
        let json = br#"{
            "captureRect": {"width": 1512, "height": 982},
            "samples": [
                {"t": 0.0, "x": 0.1, "y": 0.1, "kind": "move"},
                {"t": 0.5, "x": 0.2, "y": 0.2, "kind": "move", "shape": "pointer"},
                {"t": 1.0, "x": 0.2, "y": 0.2, "kind": "down", "shape": "pointer"},
                {"t": 1.05, "x": 0.2, "y": 0.2, "kind": "move", "shape": "grab"},
                {"t": 1.1, "x": 0.2, "y": 0.2, "kind": "up", "shape": "pointer"},
                {"t": 2.0, "x": 0.3, "y": 0.3, "kind": "down"}
            ]
        }"#;
        let meta = recording_metadata_from_cursor_json(json, None)
            .unwrap()
            .unwrap();
        assert_eq!((meta.source_width, meta.source_height), (1512.0, 982.0));
        assert_eq!(meta.cursor_click_samples.len(), 2);
        assert_eq!(
            meta.cursor_press_intervals[0],
            PressInterval {
                start: 1.0,
                end: 1.1
            }
        );
        assert_eq!(meta.cursor_press_intervals[1].end, f64::INFINITY);
        // The 0.05 s "grab" between two "pointer" runs is a glitch.
        assert_eq!(meta.cursor_samples[3].shape, Some(CursorShape::Pointer));
    }
}
