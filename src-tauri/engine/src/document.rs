//! The render document: everything the engine needs to draw an edited
//! recording, exactly as the editor holds it.
//!
//! This is the JSON contract with the TypeScript editor (`camelCase`, field for
//! field with `ExportSnapshot` in `src/windows/editor/export/exportSnapshot.ts`).
//! It carries *values*, never presets or ids: the editor resolves its own
//! presets before handing a document over, so the engine never has to know
//! what "img-image-2.webp" means. Media files and the background image travel
//! next to the document (see [`crate::export::ExportRequest`]), not inside it.
//!
//! Every field the editor might omit has a default matching the editor's own
//! default, so an older editor build cannot make the engine reject a job.

use serde::{Deserialize, Deserializer, Serialize};

/// Width × height in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// Normalized 0–1 sub-rect (screen content crop, face-cam crop).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CropNorm {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Composition aspect presets (`ASPECT_RATIO_PRESETS` in `lib/composition.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
pub enum AspectRatioPreset {
    #[default]
    #[serde(rename = "recording")]
    Recording,
    #[serde(rename = "16:9")]
    Wide16x9,
    #[serde(rename = "16:10")]
    Wide16x10,
    #[serde(rename = "9:16")]
    Tall9x16,
    #[serde(rename = "4:3")]
    Classic4x3,
    #[serde(rename = "3:4")]
    Classic3x4,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "4:5")]
    Portrait4x5,
    #[serde(rename = "5:4")]
    Landscape5x4,
    #[serde(rename = "21:9")]
    Ultra21x9,
    #[serde(rename = "9:21")]
    Ultra9x21,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundType {
    #[default]
    Image,
    Gradient,
    Color,
}

/// The look sliders (`LookParams`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    pub device_padding: f64,
    pub corner_radius: f64,
    pub recording_shadow_intensity: f64,
    pub background_blur: f64,
    pub background_darkness: f64,
}

impl Default for Look {
    /// `DEFAULT_LOOK` in `lib/composition.ts`.
    fn default() -> Self {
        Self {
            device_padding: 120.0,
            corner_radius: 18.0,
            recording_shadow_intensity: 75.0,
            background_blur: 9.0,
            background_darkness: 15.0,
        }
    }
}

/// One kept range of the source recording, in source seconds.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct TrimSegment {
    #[serde(default)]
    pub id: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ZoomMode {
    #[default]
    FollowCursor,
    FixedRect,
}

/// A zoom fragment on the timeline (`ZoomFragment` in `engine/zoomMotion.ts`).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoomFragment {
    #[serde(default)]
    pub id: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub mode: ZoomMode,
    #[serde(default = "one")]
    pub target_scale: f64,
    #[serde(default)]
    pub ease_in: f64,
    #[serde(default)]
    pub ease_out: f64,
    /// Follow-cursor pan inertia (1–20). Non-finite or < 1 means "default (4)".
    #[serde(default, deserialize_with = "lenient_f64")]
    pub damping: f64,
    #[serde(default)]
    pub fixed_rect: Option<CropNorm>,
    #[serde(default)]
    pub shrink_face_cam_during_zoom: Option<bool>,
    #[serde(default)]
    pub face_cam_zoom_presence_scale: Option<f64>,
}

/// A rectangle blurred out of the screen recording, normalized to the full file.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct BlurRegion {
    #[serde(default)]
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CursorStyle {
    Macos,
    #[default]
    Tahoe,
    TahoeInverted,
    Figma,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClickEffect {
    #[default]
    None,
    Ripple,
    Spotlight,
    Echo,
}

/// Cursor overlay settings (`CursorSettings` in `engine/cursorOverlay.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorSettings {
    pub show_cursor: bool,
    pub loop_cursor: bool,
    pub hide_static_cursor: bool,
    pub style: CursorStyle,
    pub size: f64,
    pub motion_blur: f64,
    pub smoothness: f64,
    pub click_shrink: f64,
    pub sway: f64,
    pub click_effect: ClickEffect,
}

impl Default for CursorSettings {
    /// `DEFAULT_CURSOR_SETTINGS`.
    fn default() -> Self {
        Self {
            show_cursor: true,
            loop_cursor: true,
            hide_static_cursor: true,
            style: CursorStyle::Tahoe,
            size: 3.0,
            motion_blur: 0.15,
            smoothness: 0.45,
            click_shrink: 0.2,
            sway: 0.0,
            click_effect: ClickEffect::None,
        }
    }
}

/// OS cursor shapes the recorder replays (`CURSOR_SHAPE_IDS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CursorShape {
    #[default]
    Default,
    Pointer,
    Text,
    Grab,
    Grabbing,
    Crosshair,
    ResizeEw,
    ResizeNs,
    ResizeNesw,
    ResizeNwse,
    NotAllowed,
    Alias,
    Copy,
    ContextMenu,
}

impl CursorShape {
    pub const ALL: [CursorShape; 14] = [
        Self::Default,
        Self::Pointer,
        Self::Text,
        Self::Grab,
        Self::Grabbing,
        Self::Crosshair,
        Self::ResizeEw,
        Self::ResizeNs,
        Self::ResizeNesw,
        Self::ResizeNwse,
        Self::NotAllowed,
        Self::Alias,
        Self::Copy,
        Self::ContextMenu,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CursorSample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    /// Absent for the plain arrow, and for any shape this build doesn't know.
    #[serde(default, deserialize_with = "lenient_shape")]
    pub shape: Option<CursorShape>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CursorClickSample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

/// One button hold: mouse-down at `start`, mouse-up at `end` (source seconds).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct PressInterval {
    pub start: f64,
    /// An unclosed hold runs forever. The editor holds `Infinity`, which JSON
    /// carries as `null`.
    #[serde(deserialize_with = "f64_or_infinity")]
    pub end: f64,
}

/// The recorded cursor track (`RecordingMetadata` in `engine/zoomMotion.ts`).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordingMetadata {
    pub source_width: f64,
    pub source_height: f64,
    pub cursor_samples: Vec<CursorSample>,
    pub cursor_click_samples: Vec<CursorClickSample>,
    pub cursor_press_intervals: Vec<PressInterval>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FaceCamCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    #[default]
    BottomRight,
}

/// Face-cam PiP settings (`FaceCamParams` in `windows/editor/store.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FaceCamParams {
    pub is_round: bool,
    pub width_px: f64,
    pub height_px: f64,
    pub shadow_intensity: f64,
    pub roundness: f64,
    pub corner: FaceCamCorner,
    pub position: Option<Point>,
    pub crop: Option<CropNorm>,
    pub mirrored: bool,
    pub margin_px: f64,
}

impl Default for FaceCamParams {
    /// `DEFAULT_FACE_CAM`.
    fn default() -> Self {
        Self {
            is_round: false,
            width_px: 400.0,
            height_px: 300.0,
            shadow_intensity: 100.0,
            roundness: 18.0,
            corner: FaceCamCorner::BottomRight,
            position: None,
            crop: None,
            mirrored: true,
            margin_px: 48.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionWord {
    #[serde(default)]
    pub text: String,
    #[serde(default = "nan", deserialize_with = "lenient_f64")]
    pub start_ms: f64,
    #[serde(default = "nan", deserialize_with = "lenient_f64")]
    pub end_ms: f64,
    #[serde(default)]
    pub leading_space: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCue {
    #[serde(default)]
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub words: Option<Vec<CaptionWord>>,
}

/// Caption style (`CaptionSettings` in `captions/settings.ts`), already
/// normalized by the editor's `parseCaptionSettings`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptionSettings {
    pub enabled: bool,
    pub sentence_background: Option<String>,
    pub word_background: Option<String>,
    pub word_text_color: Option<String>,
    pub sentence_radius_px: f64,
    pub word_radius_px: f64,
    pub text_color: String,
    pub font_family: String,
    pub font_size_px: f64,
    pub bottom_offset_px: f64,
    pub word_highlight: bool,
    pub timing_offset_ms: f64,
}

impl Default for CaptionSettings {
    /// `DEFAULT_CAPTION_SETTINGS`.
    fn default() -> Self {
        Self {
            enabled: false,
            sentence_background: Some("rgba(8, 8, 10, 0.82)".into()),
            word_background: Some("rgba(255, 255, 255, 0.22)".into()),
            word_text_color: None,
            sentence_radius_px: 8.0,
            word_radius_px: 6.0,
            text_color: "#ffffff".into(),
            font_family: "system-ui, -apple-system, sans-serif".into(),
            font_size_px: 38.0,
            bottom_offset_px: 48.0,
            word_highlight: true,
            timing_offset_ms: 0.0,
        }
    }
}

/// Everything the engine draws, for one edited recording.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDocument {
    /// Decoded screen-recording size, in pixels.
    pub source_video_size: Size,
    /// Width / height of the screen recording.
    pub source_aspect: f64,
    #[serde(default)]
    pub aspect_ratio_preset_id: AspectRatioPreset,
    #[serde(default)]
    pub background_type: BackgroundType,
    #[serde(default)]
    pub look: Look,
    #[serde(default)]
    pub screen_content_crop: Option<CropNorm>,
    /// Screen-recording duration in seconds.
    pub duration: f64,
    /// Kept ranges; empty means "the whole recording".
    #[serde(default)]
    pub segments: Vec<TrimSegment>,
    #[serde(default)]
    pub zoom_fragments: Vec<ZoomFragment>,
    #[serde(default)]
    pub blur_regions: Vec<BlurRegion>,
    #[serde(default)]
    pub cursor_settings: CursorSettings,
    #[serde(default)]
    pub recording_metadata: Option<RecordingMetadata>,
    #[serde(default)]
    pub face_cam: FaceCamParams,
    /// Camera start minus screen start, in ms. `null` on takes recorded
    /// before the offset was measured (treated as aligned).
    #[serde(default)]
    pub camera_offset_ms: Option<f64>,
    #[serde(default)]
    pub captions: Vec<CaptionCue>,
    #[serde(default)]
    pub caption_settings: CaptionSettings,
}

impl RenderDocument {
    /// Kept ranges, defaulting to the whole recording like the compositor does.
    pub fn kept_segments(&self) -> Vec<TrimSegment> {
        if self.segments.is_empty() {
            crate::timeline::segments::full_segment(self.duration)
        } else {
            self.segments.clone()
        }
    }
}

fn one() -> f64 {
    1.0
}

fn nan() -> f64 {
    f64::NAN
}

/// A number that may arrive as `null` (JSON's spelling of NaN) or as one of the
/// strings "Infinity" / "-Infinity" / "NaN".
#[derive(Deserialize)]
#[serde(untagged)]
enum LenientNumber {
    Number(f64),
    Text(String),
    Null(()),
}

fn parse_lenient(value: Option<LenientNumber>, null_as: f64) -> f64 {
    match value {
        Some(LenientNumber::Number(n)) => n,
        Some(LenientNumber::Text(s)) => match s.as_str() {
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        },
        Some(LenientNumber::Null(())) | None => null_as,
    }
}

/// `null` or a missing value become NaN — "not a usable number", exactly how
/// the editor treats it.
fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(parse_lenient(
        Option::<LenientNumber>::deserialize(d)?,
        f64::NAN,
    ))
}

/// `null` becomes +∞ — `JSON.stringify(Infinity)` is `null`.
fn f64_or_infinity<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(parse_lenient(
        Option::<LenientNumber>::deserialize(d)?,
        f64::INFINITY,
    ))
}

/// Unknown shape ids replay as the arrow instead of failing the whole job.
fn lenient_shape<'de, D: Deserializer<'de>>(d: D) -> Result<Option<CursorShape>, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(d)?;
    Ok(raw.and_then(|v| serde_json::from_value(v).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_interval_null_end_is_an_unclosed_hold() {
        let p: PressInterval = serde_json::from_str(r#"{"start":1.5,"end":null}"#).unwrap();
        assert_eq!(p.end, f64::INFINITY);
        let p: PressInterval = serde_json::from_str(r#"{"start":1.5,"end":"Infinity"}"#).unwrap();
        assert_eq!(p.end, f64::INFINITY);
    }

    #[test]
    fn unknown_cursor_shape_falls_back_to_arrow() {
        let s: CursorSample =
            serde_json::from_str(r#"{"t":0,"x":0.5,"y":0.5,"shape":"beachball"}"#).unwrap();
        assert_eq!(s.shape, None);
        let s: CursorSample =
            serde_json::from_str(r#"{"t":0,"x":0.5,"y":0.5,"shape":"resize-nwse"}"#).unwrap();
        assert_eq!(s.shape, Some(CursorShape::ResizeNwse));
    }

    #[test]
    fn minimal_document_takes_editor_defaults() {
        let doc: RenderDocument = serde_json::from_str(
            r#"{"sourceVideoSize":{"width":1920,"height":1080},"sourceAspect":1.7777,"duration":12}"#,
        )
        .unwrap();
        assert_eq!(doc.look, Look::default());
        assert_eq!(doc.cursor_settings, CursorSettings::default());
        assert_eq!(doc.face_cam, FaceCamParams::default());
        assert_eq!(doc.kept_segments().len(), 1);
        assert_eq!(doc.kept_segments()[0].end, 12.0);
    }
}
