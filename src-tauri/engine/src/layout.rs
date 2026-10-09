//! Stage geometry: where the recording, face-cam, shadows and blur regions sit.
//!
//! Ported from `windows/editor/lib/composition.ts`, `engine/editorCanvas.ts`
//! and `engine/blurRegions.ts`. All lengths are *composition pixels*: the look
//! values the user tunes (padding, radius, face-cam size) are absolute pixels
//! calibrated against a 1920-long-edge stage, so every function here works in
//! that space and the renderer scales the result to the output once.

use crate::document::{AspectRatioPreset, BlurRegion, CropNorm, FaceCamCorner, Point, Size};
use crate::math::{clamp, js_max, js_min, js_round, Rect};

/// Long edge the look values are calibrated against.
pub const COMPOSITION_REFERENCE_LONG_EDGE: f64 = 1920.0;

impl AspectRatioPreset {
    /// Fixed stage size for every preset but `Recording`, which follows the
    /// source (`ASPECT_RATIO_PRESETS`).
    pub fn fixed_size(self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Recording => return None,
            Self::Wide16x9 => (1920.0, 1080.0),
            Self::Wide16x10 => (1920.0, 1200.0),
            Self::Tall9x16 => (1080.0, 1920.0),
            Self::Classic4x3 => (1440.0, 1080.0),
            Self::Classic3x4 => (1080.0, 1440.0),
            Self::Square => (1080.0, 1080.0),
            Self::Portrait4x5 => (1080.0, 1350.0),
            Self::Landscape5x4 => (1350.0, 1080.0),
            Self::Ultra21x9 => (2520.0, 1080.0),
            Self::Ultra9x21 => (1080.0, 2520.0),
        })
    }
}

/// Stage size that keeps the recording's aspect, long edge capped and both
/// sides even (`computeStageDimensionsForVideo`).
pub fn stage_dimensions_for_video(video_width: f64, video_height: f64, max_long_edge: f64) -> Size {
    let source_width = js_max(1.0, js_round(video_width));
    let source_height = js_max(1.0, js_round(video_height));
    let scale = max_long_edge / js_max(source_width, source_height);
    let mut width = js_max(2.0, js_round(source_width * scale));
    let mut height = js_max(2.0, js_round(source_height * scale));
    if width % 2.0 != 0.0 {
        width += 1.0;
    }
    if height % 2.0 != 0.0 {
        height += 1.0;
    }
    Size { width, height }
}

/// Hardware H.264 encoders want macroblock-aligned frames (`alignEncoderDimensions`).
pub fn align_encoder_dimensions(width: f64, height: f64) -> Size {
    let align = |v: f64| js_max(16.0, (js_max(1.0, v) / 16.0).floor() * 16.0);
    Size {
        width: align(width),
        height: align(height),
    }
}

/// Encoder output size for a stage (`computeExportDimensionsForVideo`).
pub fn export_dimensions_for_video(
    video_width: f64,
    video_height: f64,
    max_long_edge: f64,
) -> Size {
    let stage = stage_dimensions_for_video(video_width, video_height, max_long_edge);
    align_encoder_dimensions(stage.width, stage.height)
}

/// The editor's single source of truth for stage size (`resolveStageSize`).
pub fn resolve_stage_size(preset: AspectRatioPreset, source_video_size: Option<Size>) -> Size {
    match preset.fixed_size() {
        Some((width, height)) => Size { width, height },
        None => match source_video_size {
            Some(size) => stage_dimensions_for_video(size.width, size.height, 1920.0),
            None => Size {
                width: 1920.0,
                height: 1080.0,
            },
        },
    }
}

/// The size the scene is composed at for a given output, and the factor that
/// maps composition pixels onto output pixels.
///
/// Outputs below the reference long edge (GIF) compose at the reference and
/// downscale, so absolute look values keep their proportions — the same rule
/// as `createExportCompositorFromMedia`. Larger outputs compose 1:1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompositionSize {
    pub width: f64,
    pub height: f64,
    /// Output pixels per composition pixel (≤ 1).
    pub output_scale: f64,
}

pub fn composition_size_for_output(output_width: u32, output_height: u32) -> CompositionSize {
    let long_edge = f64::from(output_width.max(output_height));
    let superscale = if long_edge >= COMPOSITION_REFERENCE_LONG_EDGE {
        1.0
    } else {
        COMPOSITION_REFERENCE_LONG_EDGE / long_edge
    };
    CompositionSize {
        width: js_max(2.0, js_round(f64::from(output_width) * superscale)),
        height: js_max(2.0, js_round(f64::from(output_height) * superscale)),
        output_scale: 1.0 / superscale,
    }
}

/// Aspect of the visible screen pixels after the content crop
/// (`computeEffectiveSourceAspect`).
pub fn effective_source_aspect(video_width: f64, video_height: f64, crop: Option<CropNorm>) -> f64 {
    let video_width = js_max(1.0, video_width);
    let video_height = js_max(1.0, video_height);
    let base = video_width / video_height;
    match crop {
        Some(c) if c.width > 1e-6 && c.height > 1e-6 => (c.width / c.height) * base,
        _ => base,
    }
}

/// Inputs shared by the recording-rect layout rules.
#[derive(Debug, Clone, Copy)]
pub struct RecordingLayoutInput {
    pub preset: AspectRatioPreset,
    pub source_aspect: f64,
    pub source_video_size: Option<Size>,
    pub has_selected_background: bool,
    pub has_image_background: bool,
    pub device_padding: f64,
    pub screen_content_crop: Option<CropNorm>,
}

/// Device padding and layout aspect for the recording rect
/// (`resolveRecordingLayoutParams`).
pub fn recording_layout_params(input: &RecordingLayoutInput) -> (f64, f64) {
    let aspect = if input.preset == AspectRatioPreset::Recording
        && !input.has_image_background
        && input.source_video_size.is_some()
    {
        let size = input.source_video_size.unwrap_or(Size {
            width: 1.0,
            height: 1.0,
        });
        size.width / size.height
    } else if !input.has_selected_background {
        input.source_aspect
    } else {
        let w = js_max(1.0, input.source_video_size.map_or(1.0, |s| s.width));
        let h = js_max(1.0, input.source_video_size.map_or(1.0, |s| s.height));
        effective_source_aspect(w, h, input.screen_content_crop)
    };
    // No background, or "Match" without an image: the recording fills the stage.
    let fills_stage = !input.has_selected_background
        || (input.preset == AspectRatioPreset::Recording && !input.has_image_background);
    let padding = if fills_stage {
        0.0
    } else {
        input.device_padding
    };
    (aspect, padding)
}

/// The padded device rect and the letterboxed recording inside it
/// (`getCompositionLayout`).
pub fn composition_layout(
    source_aspect: f64,
    width: f64,
    height: f64,
    device_padding: f64,
) -> (Rect, Rect) {
    let safe_aspect = if source_aspect.is_finite() && source_aspect > 0.0 {
        source_aspect
    } else {
        16.0 / 9.0
    };
    let device = Rect::new(
        device_padding,
        device_padding,
        width - device_padding * 2.0,
        height - device_padding * 2.0,
    );
    let device_aspect = device.width / device.height;
    let (video_width, video_height) = if safe_aspect > device_aspect {
        (device.width, device.width / safe_aspect)
    } else {
        (device.height * safe_aspect, device.height)
    };
    let video = Rect::new(
        device.x + (device.width - video_width) / 2.0,
        device.y + (device.height - video_height) / 2.0,
        video_width,
        video_height,
    );
    (device, video)
}

/// The recording rect on a `width`×`height` stage.
pub fn recording_rect(input: &RecordingLayoutInput, width: f64, height: f64) -> Rect {
    let (aspect, padding) = recording_layout_params(input);
    composition_layout(aspect, width, height, padding).1
}

/// The recording rect as fractions of the stage — the space fixed-rect zoom
/// centres are mapped through (`resolveZoomCompositionLayout`).
pub fn recording_rect_fraction(input: &RecordingLayoutInput, width: f64, height: f64) -> Rect {
    let video = recording_rect(input, width, height);
    Rect::new(
        video.x / js_max(1e-6, width),
        video.y / js_max(1e-6, height),
        video.width / js_max(1e-6, width),
        video.height / js_max(1e-6, height),
    )
}

/// One blurred silhouette in a drop-shadow stack (`ShadowPass`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadowPass {
    /// Gaussian standard deviation in composition px (CSS `blur(<sigma>px)`).
    pub sigma: f64,
    pub opacity: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

/// Recording drop shadow: ambient + contact layers (`recordingShadowPasses`).
pub fn recording_shadow_passes(intensity: f64, short_edge: f64) -> Vec<ShadowPass> {
    const LAYERS: [(f64, f64); 3] = [(48.0, 0.7), (16.0, 0.5), (8.0, 0.3)];
    const SHADOW_REFERENCE_EDGE: f64 = 1080.0;
    const MAX_SHADOW_PASS_OPACITY: f64 = 0.85;

    let strength = js_max(0.0, intensity / 100.0);
    if strength <= 0.0 || strength.is_nan() {
        return Vec::new();
    }
    let spread = (short_edge / SHADOW_REFERENCE_EDGE) * strength;
    let density = if strength <= 1.0 {
        strength
    } else {
        1.0 + (strength - 1.0) * 0.3
    };
    LAYERS
        .iter()
        .map(|&(sigma, opacity)| ShadowPass {
            sigma: sigma * spread,
            opacity: js_min(MAX_SHADOW_PASS_OPACITY, opacity * density),
            offset_x: 0.0,
            offset_y: 0.0,
        })
        .collect()
}

/// `FACE_CAM_COMPOSITION` in `engine/constants.ts`.
mod face_cam_constants {
    pub const WIDTH_RATIO: f64 = 0.2;
    pub const MIN_WIDTH: f64 = 120.0;
    pub const MAX_WIDTH: f64 = 960.0;
    pub const MIN_HEIGHT: f64 = 90.0;
    pub const MAX_HEIGHT: f64 = 720.0;
    pub const ASPECT_RATIO: f64 = 4.0 / 3.0;
    pub const MARGIN_RATIO: f64 = 0.04;
    pub const MIN_MARGIN: f64 = 10.0;
    pub const CORNER_RADIUS_RATIO: f64 = 0.12;
    pub const SHADOW_BLUR: f64 = 24.0;
    pub const SHADOW_OFFSET_X: f64 = 0.0;
    pub const SHADOW_OFFSET_Y: f64 = 10.0;
    pub const SHADOW_OPACITY: f64 = 0.42;
    pub const MARGIN_MIN: f64 = 0.0;
    pub const MARGIN_MAX: f64 = 96.0;
}

/// Face-cam inset from the stage edge; auto when not set (`resolveFaceCamMargin`).
pub fn face_cam_margin(width: f64, height: f64, margin_px: Option<f64>) -> f64 {
    use face_cam_constants as fc;
    if let Some(margin) = margin_px.filter(|m| m.is_finite()) {
        return clamp(margin, fc::MARGIN_MIN, fc::MARGIN_MAX);
    }
    let base_margin = js_max(fc::MIN_MARGIN, js_min(width, height) * fc::MARGIN_RATIO);
    let shadow_inset_budget =
        fc::SHADOW_BLUR + js_max(fc::SHADOW_OFFSET_X.abs(), fc::SHADOW_OFFSET_Y.abs());
    js_max(6.0, base_margin + shadow_inset_budget * 0.18)
}

/// Options for [`face_cam_layout`] (`FaceCamDrawOptions`). `None` / non-finite
/// numbers mean "use the default", like `Number.isFinite` checks in the editor.
#[derive(Debug, Clone, Copy, Default)]
pub struct FaceCamLayoutOptions {
    pub shadow_intensity: f64,
    pub corner_roundness: Option<f64>,
    pub width_px: Option<f64>,
    pub height_px: Option<f64>,
    pub force_circle: bool,
    pub position_override: Option<Point>,
    pub corner: FaceCamCorner,
    pub crop: Option<CropNorm>,
    pub presence_scale: Option<f64>,
    pub margin_px: Option<f64>,
}

/// The face-cam shadow stack geometry (`FaceCamShadowLayout`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceCamShadow {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
    pub soft_sigma: f64,
    pub soft_opacity: f64,
    pub tight_sigma: f64,
    pub tight_opacity: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

/// Where the PiP goes and which camera pixels it shows (`resolveFaceCamLayout`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceCamLayout {
    pub x: f64,
    pub y: f64,
    pub cam_width: f64,
    pub cam_height: f64,
    pub corner_radius: f64,
    pub corner: FaceCamCorner,
    pub presence_scale: f64,
    pub source: Rect,
    pub shadow: FaceCamShadow,
}

pub fn face_cam_layout(
    video_width: f64,
    video_height: f64,
    width: f64,
    height: f64,
    options: &FaceCamLayoutOptions,
) -> Option<FaceCamLayout> {
    use face_cam_constants as fc;
    if video_width <= 0.0 || video_height <= 0.0 || video_width.is_nan() || video_height.is_nan() {
        return None;
    }
    let finite = |v: Option<f64>| v.filter(|x| x.is_finite());

    let intensity_factor = js_max(0.0, options.shadow_intensity / 35.0);
    let base_sigma = fc::SHADOW_BLUR / 2.0;
    let soft_sigma = js_max(4.0, base_sigma * (0.7 + intensity_factor * 0.7));
    let soft_opacity = js_min(0.8, fc::SHADOW_OPACITY * (0.35 + intensity_factor * 0.65));
    let tight_sigma = js_max(2.0, base_sigma * (0.3 + intensity_factor * 0.35));
    let tight_opacity = js_min(0.65, fc::SHADOW_OPACITY * (0.25 + intensity_factor * 0.45));

    let base_size = js_min(width, height) * fc::WIDTH_RATIO;
    let width_px = finite(options.width_px).unwrap_or(base_size);
    let height_px = finite(options.height_px).unwrap_or(base_size / fc::ASPECT_RATIO);

    let (cam_width, cam_height) = if options.force_circle {
        let min_round = js_max(fc::MIN_WIDTH, fc::MIN_HEIGHT);
        let max_round = js_min(fc::MAX_WIDTH, fc::MAX_HEIGHT);
        let size = js_max(min_round, js_min(max_round, js_max(width_px, height_px)));
        (size, size)
    } else {
        (
            js_max(fc::MIN_WIDTH, js_min(fc::MAX_WIDTH, width_px)),
            js_max(fc::MIN_HEIGHT, js_min(fc::MAX_HEIGHT, height_px)),
        )
    };

    let corner = options.corner;
    let margin = face_cam_margin(width, height, Some(options.margin_px.unwrap_or(48.0)));
    let left = matches!(corner, FaceCamCorner::TopLeft | FaceCamCorner::BottomLeft);
    let top = matches!(corner, FaceCamCorner::TopLeft | FaceCamCorner::TopRight);
    let corner_x = if left {
        margin
    } else {
        width - cam_width - margin
    };
    let corner_y = if top {
        margin
    } else {
        height - cam_height - margin
    };
    let (x, y) = match options.position_override {
        Some(p) => (p.x, p.y),
        None => (corner_x, corner_y),
    };

    let short = js_min(cam_width, cam_height);
    let roundness = if options.force_circle {
        short / 2.0
    } else {
        finite(options.corner_roundness).unwrap_or(short * fc::CORNER_RADIUS_RATIO)
    };
    let corner_radius = js_max(0.0, js_min(short / 2.0, roundness));

    let (ox, oy, rw, rh) = match options.crop {
        Some(crop) => {
            let c = content_rect_pixels_from_crop(video_width, video_height, crop);
            (c.x, c.y, c.width, c.height)
        }
        None => (0.0, 0.0, video_width, video_height),
    };
    let target_aspect = cam_width / cam_height;
    let source_aspect = rw / rh;
    let mut source = Rect::new(ox, oy, rw, rh);
    if source_aspect > target_aspect {
        source.width = rh * target_aspect;
        source.x = ox + (rw - source.width) / 2.0;
    } else {
        source.height = rw / target_aspect;
        source.y = oy + (rh - source.height) / 2.0;
    }

    let inset = 1.0;
    let presence_scale = match finite(options.presence_scale) {
        Some(p) => js_min(1.0, js_max(1e-6, p)),
        None => 1.0,
    };

    Some(FaceCamLayout {
        x,
        y,
        cam_width,
        cam_height,
        corner_radius,
        corner,
        presence_scale,
        source,
        shadow: FaceCamShadow {
            x: x + inset,
            y: y + inset,
            w: js_max(1.0, cam_width - inset * 2.0),
            h: js_max(1.0, cam_height - inset * 2.0),
            r: js_max(0.0, corner_radius - inset),
            soft_sigma,
            soft_opacity,
            tight_sigma,
            tight_opacity,
            offset_x: fc::SHADOW_OFFSET_X,
            offset_y: fc::SHADOW_OFFSET_Y,
        },
    })
}

/// The PiP's two-layer shadow (`faceCamShadowPasses`).
pub fn face_cam_shadow_passes(shadow: &FaceCamShadow) -> [ShadowPass; 2] {
    [
        ShadowPass {
            sigma: shadow.soft_sigma,
            opacity: shadow.soft_opacity,
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
        },
        ShadowPass {
            sigma: shadow.tight_sigma,
            opacity: shadow.tight_opacity,
            offset_x: shadow.offset_x,
            offset_y: js_max(2.0, shadow.offset_y * 0.55),
        },
    ]
}

/// Face-cam scale from the zoom envelope (`computeFaceCamZoomPresenceScale`).
pub fn face_cam_zoom_presence_scale(zoom_envelope: f64, min_scale_at_full_zoom: f64) -> f64 {
    let env = if zoom_envelope.is_finite() {
        js_min(1.0, js_max(0.0, zoom_envelope))
    } else {
        0.0
    };
    if env <= 1e-9 {
        return 1.0;
    }
    let min_scale = if min_scale_at_full_zoom.is_finite() {
        js_min(1.0, js_max(1e-6, min_scale_at_full_zoom))
    } else {
        1.0
    };
    1.0 - (1.0 - min_scale) * env
}

const MIN_CONTENT_CROP: f64 = 0.02;

/// `clampScreenContentCropNorm`.
pub fn clamp_crop(c: CropNorm) -> CropNorm {
    let x = js_min(1.0, js_max(0.0, c.x));
    let y = js_min(1.0, js_max(0.0, c.y));
    let max_w = js_max(MIN_CONTENT_CROP, 1.0 - x);
    let max_h = js_max(MIN_CONTENT_CROP, 1.0 - y);
    CropNorm {
        x,
        y,
        width: js_max(MIN_CONTENT_CROP, js_min(max_w, js_min(1.0, c.width))),
        height: js_max(MIN_CONTENT_CROP, js_min(max_h, js_min(1.0, c.height))),
    }
}

/// Source-pixel rect of a normalized crop (`contentRectPixelsFromCrop`).
pub fn content_rect_pixels_from_crop(video_width: f64, video_height: f64, crop: CropNorm) -> Rect {
    let c = clamp_crop(crop);
    let w = js_max(1.0, video_width);
    let h = js_max(1.0, video_height);
    Rect::new(c.x * w, c.y * h, c.width * w, c.height * h)
}

/// The source-pixel rect the screen sprite shows: the crop, or the full frame.
pub fn screen_content_rect(video_width: f64, video_height: f64, crop: Option<CropNorm>) -> Rect {
    match crop {
        Some(c) => content_rect_pixels_from_crop(video_width, video_height, c),
        None => Rect::new(0.0, 0.0, video_width, video_height),
    }
}

pub const BLUR_REGION_MIN_SIZE: f64 = 0.02;

/// `clampBlurRegion`.
pub fn clamp_blur_region(region: &BlurRegion) -> CropNorm {
    let or = |v: f64, fallback: f64| if v.is_finite() { v } else { fallback };
    let width = clamp(
        or(region.width, BLUR_REGION_MIN_SIZE),
        BLUR_REGION_MIN_SIZE,
        1.0,
    );
    let height = clamp(
        or(region.height, BLUR_REGION_MIN_SIZE),
        BLUR_REGION_MIN_SIZE,
        1.0,
    );
    CropNorm {
        x: clamp(or(region.x, 0.0), 0.0, 1.0 - width),
        y: clamp(or(region.y, 0.0), 0.0, 1.0 - height),
        width,
        height,
    }
}

/// Which source pixels a blur region covers and where they land on the stage
/// (`blurRegionPlacement`). `None` when the region misses the visible content.
pub fn blur_region_placement(
    region: &BlurRegion,
    source_width: f64,
    source_height: f64,
    content: Rect,
    rect: Rect,
) -> Option<(Rect, Rect)> {
    let positive = |v: f64| v > 0.0;
    if !(positive(source_width)
        && positive(source_height)
        && positive(content.width)
        && positive(content.height)
        && positive(rect.width)
        && positive(rect.height))
    {
        return None;
    }
    let safe = clamp_blur_region(region);
    let left = js_max(safe.x * source_width, content.x);
    let top = js_max(safe.y * source_height, content.y);
    let right = js_min(
        (safe.x + safe.width) * source_width,
        content.x + content.width,
    );
    let bottom = js_min(
        (safe.y + safe.height) * source_height,
        content.y + content.height,
    );
    // Negated on purpose: a NaN edge must reject the region, as in the editor.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    let empty = !(right > left) || !(bottom > top);
    if empty {
        return None;
    }
    let scale_x = rect.width / content.width;
    let scale_y = rect.height / content.height;
    Some((
        Rect::new(left, top, right - left, bottom - top),
        Rect::new(
            rect.x + (left - content.x) * scale_x,
            rect.y + (top - content.y) * scale_y,
            (right - left) * scale_x,
            (bottom - top) * scale_y,
        ),
    ))
}

/// `object-fit: cover` destination rect (`coverDestRect`).
pub fn cover_dest_rect(src_w: f64, src_h: f64, dest_w: f64, dest_h: f64) -> Rect {
    let sw = js_max(1.0, src_w);
    let sh = js_max(1.0, src_h);
    let tw = js_max(1.0, dest_w);
    let th = js_max(1.0, dest_h);
    let scale = js_max(tw / sw, th / sh);
    let width = sw * scale;
    let height = sh * scale;
    Rect::new((tw - width) / 2.0, (th - height) / 2.0, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composition_composes_small_outputs_at_reference() {
        let c = composition_size_for_output(1280, 720);
        assert_eq!((c.width, c.height), (1920.0, 1080.0));
        assert!((c.output_scale - 1280.0 / 1920.0).abs() < 1e-12);
        let c = composition_size_for_output(1920, 1072);
        assert_eq!((c.width, c.height, c.output_scale), (1920.0, 1072.0, 1.0));
    }

    #[test]
    fn retina_capture_stage_keeps_aspect() {
        let s = stage_dimensions_for_video(3024.0, 1964.0, 1920.0);
        assert_eq!((s.width, s.height), (1920.0, 1248.0));
        let e = export_dimensions_for_video(1920.0, 1080.0, 1920.0);
        assert_eq!((e.width, e.height), (1920.0, 1072.0));
    }
}
