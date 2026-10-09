//! The scene at one instant: a pure function of the document and a time.
//!
//! [`SceneBuilder::frame`] answers "what is on screen at source time `t`" as a
//! plain list of shapes in composition pixels — no GPU, no decoding. The
//! compositor draws it; tests can inspect it. This is the seam that keeps the
//! preview and the export identical: both ask the same builder.
//!
//! Draw order and grouping mirror the Pixi stage in
//! `windows/editor/render/pixiCompositor.ts`:
//!
//! ```text
//! background
//! camera (zoom) ─ recording shadow, screen, blur regions, cursor (fx, trail, heads)
//! face-cam ─ shadow, video
//! captions
//! ```

use crate::document::ClickEffect;
use crate::document::{BackgroundType, CursorShape, RenderDocument};
use crate::layout::{
    self, blur_region_placement, face_cam_layout, face_cam_shadow_passes, recording_shadow_passes,
    screen_content_rect, FaceCamLayoutOptions, RecordingLayoutInput, ShadowPass,
};
use crate::math::{js_max, js_min, Rect};
use crate::timeline::captions::CaptionTrack;
use crate::timeline::cursor::CursorTimeline;
use crate::timeline::face_cam::{face_cam_frame_at, FaceCamFrame};
use crate::timeline::zoom::{camera_transform, CameraTransform, ZoomTimeline};

/// Pixi's `BlurFilter({ strength: 18 })` (`BLUR_REGION_STRENGTH`) at its
/// default quality: four 5-tap passes whose variances add up to a Gaussian of
/// σ ≈ 1.2923 × strength, measured in *render* pixels (it ignores the zoom).
pub const BLUR_REGION_SIGMA: f64 = 1.292_299 * 18.0;

/// Click-ring colour (`0x2563eb`).
pub const CLICK_FX_RGB: [f64; 3] = [37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0];

/// A drop shadow behind a rounded rect.
#[derive(Debug, Clone, PartialEq)]
pub struct ShadowDraw {
    pub rect: Rect,
    pub radius: f64,
    pub passes: Vec<ShadowPass>,
}

impl ShadowDraw {
    /// How far the shadow reaches past its rect (3σ + offset per pass).
    pub fn reach(&self) -> f64 {
        self.passes
            .iter()
            .map(|p| p.sigma * 3.0 + p.offset_x.abs().max(p.offset_y.abs()))
            .fold(0.0, f64::max)
            .ceil()
    }
}

/// The screen recording on the stage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenDraw {
    /// Where it lands, before the camera.
    pub dest: Rect,
    /// Which source pixels it shows.
    pub source: Rect,
    pub radius: f64,
}

/// A blurred patch of the screen recording.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlurDraw {
    pub source: Rect,
    pub dest: Rect,
}

/// One cursor glyph placement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorSprite {
    pub shape: CursorShape,
    /// Hotspot position in composition px (camera space).
    pub tip_x: f64,
    pub tip_y: f64,
    /// Glyph height in composition px (width follows the glyph's aspect).
    pub height: f64,
    pub rotation: f64,
    pub alpha: f64,
}

/// A click-effect circle: stroked when `stroke_width > 0`, else filled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RingDraw {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub stroke_width: f64,
    pub alpha: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CursorDraw {
    /// Painted before the glyphs.
    pub rings: Vec<RingDraw>,
    /// Trail ghosts (oldest first), then the head glyph(s).
    pub sprites: Vec<CursorSprite>,
}

/// The face-cam PiP: drawn in its own local space, then placed by
/// `position + (local − pivot) × scale`.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceCamDraw {
    pub position: (f64, f64),
    pub pivot: (f64, f64),
    pub scale: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    /// Camera source pixels.
    pub source: Rect,
    pub mirrored: bool,
    /// Camera media time to show.
    pub media_time: f64,
    pub shadow: ShadowDraw,
}

/// Which caption is on screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionsDraw {
    pub cue_index: usize,
    /// −1 when no word is highlighted.
    pub active_word_index: isize,
}

/// Everything drawn for one output frame, in composition pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameScene {
    /// Draw the background image with this black overlay (0–1); `None` paints
    /// the plain black backdrop.
    pub background_darkness: Option<f64>,
    pub camera: CameraTransform,
    pub recording_shadow: Option<ShadowDraw>,
    pub screen: Option<ScreenDraw>,
    pub blur_regions: Vec<BlurDraw>,
    pub cursor: Option<CursorDraw>,
    pub face_cam: Option<FaceCamDraw>,
    pub captions: Option<CaptionsDraw>,
}

/// Sizes the builder needs from the media.
#[derive(Debug, Clone, Copy)]
pub struct MediaSizes {
    pub screen_width: f64,
    pub screen_height: f64,
    /// `(width, height, duration)` of the camera track, when there is one.
    pub camera: Option<(f64, f64, f64)>,
}

/// Width / height of each cursor glyph after trimming.
pub trait GlyphAspect {
    fn aspect(&self, shape: CursorShape) -> f64;
}

/// Prepared, time-independent state for one document.
pub struct SceneBuilder {
    doc: RenderDocument,
    has_background: bool,
    width: f64,
    height: f64,
    media: MediaSizes,
    recording_rect: Rect,
    zoom: ZoomTimeline,
    cursor: Option<CursorTimeline>,
    captions: CaptionTrack,
}

impl SceneBuilder {
    /// `width`×`height` is the composition size (see
    /// [`layout::composition_size_for_output`]).
    pub fn new(
        doc: RenderDocument,
        has_background: bool,
        width: f64,
        height: f64,
        media: MediaSizes,
    ) -> Self {
        let layout_input = Self::layout_input(&doc, has_background, &media);
        let recording_rect = layout::recording_rect(&layout_input, width, height);
        let recording_fraction = layout::recording_rect_fraction(&layout_input, width, height);
        let segments = doc.kept_segments();
        let zoom = ZoomTimeline::new(
            &doc.zoom_fragments,
            doc.recording_metadata.as_ref(),
            doc.screen_content_crop,
            recording_fraction,
        );
        let cursor = CursorTimeline::new(
            doc.cursor_settings,
            doc.recording_metadata.as_ref(),
            doc.screen_content_crop,
            &segments,
            doc.duration,
        );
        let captions = if doc.caption_settings.enabled {
            CaptionTrack::new(&doc.captions)
        } else {
            CaptionTrack::new(&[])
        };
        Self {
            doc,
            has_background,
            width,
            height,
            media,
            recording_rect,
            zoom,
            cursor,
            captions,
        }
    }

    fn layout_input(
        doc: &RenderDocument,
        has_background: bool,
        media: &MediaSizes,
    ) -> RecordingLayoutInput {
        RecordingLayoutInput {
            preset: doc.aspect_ratio_preset_id,
            source_aspect: doc.source_aspect,
            // The compositor falls back to the decoded size when the editor
            // had none; the document always carries one.
            source_video_size: Some(
                if doc.source_video_size.width > 0.0 && doc.source_video_size.height > 0.0 {
                    doc.source_video_size
                } else {
                    crate::document::Size {
                        width: media.screen_width,
                        height: media.screen_height,
                    }
                },
            ),
            has_selected_background: has_background,
            has_image_background: has_background && doc.background_type == BackgroundType::Image,
            device_padding: doc.look.device_padding,
            screen_content_crop: doc.screen_content_crop,
        }
    }

    pub fn document(&self) -> &RenderDocument {
        &self.doc
    }

    pub fn captions(&self) -> &CaptionTrack {
        &self.captions
    }

    pub fn recording_rect(&self) -> Rect {
        self.recording_rect
    }

    /// The scene at source time `t`.
    pub fn frame(&self, t: f64, glyphs: &dyn GlyphAspect) -> FrameScene {
        let doc = &self.doc;
        let (w, h) = (self.width, self.height);
        let rect = self.recording_rect;
        let radius = js_max(
            0.0,
            js_min(
                doc.look.corner_radius,
                js_min(rect.width, rect.height) / 2.0,
            ),
        );

        let zoom = self.zoom.sample(t);
        let camera = camera_transform(
            w,
            h,
            rect,
            zoom.focus,
            zoom.scale,
            zoom.reactive.target_scale,
        );

        let recording_shadow = (self.has_background && doc.look.recording_shadow_intensity > 0.0)
            .then(|| ShadowDraw {
                rect,
                radius,
                passes: recording_shadow_passes(doc.look.recording_shadow_intensity, w.min(h)),
            });

        let (sw, sh) = (self.media.screen_width, self.media.screen_height);
        let content = screen_content_rect(sw, sh, doc.screen_content_crop);

        let blur_regions = doc
            .blur_regions
            .iter()
            .filter_map(|region| blur_region_placement(region, sw, sh, content, rect))
            .map(|(source, dest)| BlurDraw { source, dest })
            .collect();

        let cursor = self.cursor_draw(t, rect, glyphs);
        let face_cam = self.face_cam_draw(t, zoom.reactive.face_cam_presence_scale);
        let captions = self.captions_draw(t);

        FrameScene {
            background_darkness: self
                .has_background
                .then(|| (doc.look.background_darkness / 100.0).clamp(0.0, 1.0)),
            camera,
            recording_shadow,
            screen: Some(ScreenDraw {
                dest: rect,
                source: content,
                radius,
            }),
            blur_regions,
            cursor,
            face_cam,
            captions,
        }
    }

    fn cursor_draw(&self, t: f64, rect: Rect, glyphs: &dyn GlyphAspect) -> Option<CursorDraw> {
        let frame = self.cursor.as_ref()?.frame(t, rect.width, rect.height)?;
        let settings = &self.doc.cursor_settings;
        let to_stage = |x: f64, y: f64| (rect.x + x * rect.width, rect.y + y * rect.height);

        let mut sprites = Vec::with_capacity(frame.trail.len() + frame.heads.len());
        // Oldest ghost first, so the head paints on top.
        for (pos, alpha) in frame.trail.iter().rev() {
            let (x, y) = to_stage(pos.x, pos.y);
            sprites.push(CursorSprite {
                shape: frame.trail_shape,
                tip_x: x,
                tip_y: y,
                height: frame.height,
                rotation: 0.0,
                alpha: *alpha,
            });
        }
        let (tip_x, tip_y) = to_stage(frame.tip.x, frame.tip.y);
        for &(shape, alpha) in &frame.heads {
            sprites.push(CursorSprite {
                shape,
                tip_x,
                tip_y,
                height: frame.height * frame.bounce,
                rotation: frame.rotation,
                alpha,
            });
        }
        // Width is derived at draw time; validate the aspect exists now so a
        // missing glyph fails loudly in tests rather than drawing nothing.
        debug_assert!(sprites.iter().all(|s| glyphs.aspect(s.shape) > 0.0));

        let rings = click_rings(
            settings.click_effect,
            tip_x,
            tip_y,
            frame.height * frame.bounce,
            frame.fx_progress,
        );
        Some(CursorDraw { rings, sprites })
    }

    fn face_cam_draw(&self, t: f64, presence: f64) -> Option<FaceCamDraw> {
        let (cam_w, cam_h, cam_duration) = self.media.camera?;
        let frame = face_cam_frame_at(t, self.doc.camera_offset_ms, cam_duration);
        if frame == FaceCamFrame::Before {
            return None;
        }
        let media_time = frame.media_time()?;
        let fc = &self.doc.face_cam;
        let layout = face_cam_layout(
            cam_w,
            cam_h,
            self.width,
            self.height,
            &FaceCamLayoutOptions {
                shadow_intensity: fc.shadow_intensity,
                corner_roundness: (!fc.is_round).then_some(fc.roundness),
                width_px: Some(fc.width_px),
                height_px: Some(if fc.is_round {
                    fc.width_px
                } else {
                    fc.height_px
                }),
                force_circle: fc.is_round,
                position_override: fc.position,
                corner: fc.corner,
                crop: fc.crop,
                presence_scale: Some(presence),
                margin_px: Some(fc.margin_px),
            },
        )?;
        use crate::document::FaceCamCorner as C;
        let anchor_x = if matches!(layout.corner, C::TopLeft | C::BottomLeft) {
            0.0
        } else {
            layout.cam_width
        };
        let anchor_y = if matches!(layout.corner, C::TopLeft | C::TopRight) {
            0.0
        } else {
            layout.cam_height
        };
        let sh = layout.shadow;
        Some(FaceCamDraw {
            position: (layout.x + anchor_x, layout.y + anchor_y),
            pivot: (anchor_x, anchor_y),
            scale: layout.presence_scale,
            width: layout.cam_width,
            height: layout.cam_height,
            radius: layout.corner_radius,
            source: layout.source,
            mirrored: fc.mirrored,
            media_time,
            // The compositor places the baked shadow at the PiP's local origin.
            shadow: ShadowDraw {
                rect: Rect::new(0.0, 0.0, sh.w, sh.h),
                radius: sh.r,
                passes: face_cam_shadow_passes(&sh).to_vec(),
            },
        })
    }

    fn captions_draw(&self, t: f64) -> Option<CaptionsDraw> {
        let settings = &self.doc.caption_settings;
        if !settings.enabled || self.captions.is_empty() {
            return None;
        }
        let active = self
            .captions
            .active(t * 1000.0 + settings.timing_offset_ms)?;
        Some(CaptionsDraw {
            cue_index: active.cue_index,
            active_word_index: active.active_word_index,
        })
    }
}

/// Click effect geometry (`PixiCursorOverlay.drawFx`).
fn click_rings(
    effect: ClickEffect,
    x: f64,
    y: f64,
    cursor_size: f64,
    progress: f64,
) -> Vec<RingDraw> {
    if effect == ClickEffect::None || progress <= 0.0 {
        return Vec::new();
    }
    let reveal = 1.0 - progress;
    let alpha = progress;
    let base_radius = (cursor_size * 0.55).max(12.0);
    let stroke_width = (cursor_size * 0.08).max(2.0);
    let ring = |radius: f64, stroke_width: f64, alpha: f64| RingDraw {
        x,
        y,
        radius,
        stroke_width,
        alpha,
    };
    match effect {
        ClickEffect::None => Vec::new(),
        ClickEffect::Ripple => {
            let radius = ((1.0 - progress.powf(1.35)) * cursor_size * 1.95).max(0.5);
            let a = (progress.powi(3) * 0.6).clamp(0.0, 1.0);
            vec![ring(radius, (2.0 * progress).max(1.0), a)]
        }
        ClickEffect::Spotlight => {
            let glow_radius = base_radius + reveal * cursor_size;
            let inner_radius = (base_radius * 0.72).max(glow_radius * 0.76);
            vec![
                ring(glow_radius, (stroke_width * 0.68).max(1.25), alpha * 0.28),
                ring(inner_radius, (stroke_width * 0.75).max(1.5), alpha * 0.5),
            ]
        }
        ClickEffect::Echo => {
            let outer = base_radius + reveal * cursor_size * 1.22;
            let inner = (base_radius * 0.58).max(outer * 0.62);
            vec![
                ring(outer, stroke_width, alpha * 0.72),
                ring(inner, (stroke_width * 0.72).max(1.4), alpha * 0.42),
                ring((base_radius * 0.18).max(3.0), 0.0, alpha * 0.14),
            ]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{CursorSample, RecordingMetadata, Size};

    struct Square;
    impl GlyphAspect for Square {
        fn aspect(&self, _: CursorShape) -> f64 {
            1.0
        }
    }

    fn doc() -> RenderDocument {
        serde_json::from_value(serde_json::json!({
            "sourceVideoSize": {"width": 3024, "height": 1964},
            "sourceAspect": 3024.0 / 1964.0,
            "aspectRatioPresetId": "16:9",
            "duration": 10.0,
        }))
        .unwrap()
    }

    fn media() -> MediaSizes {
        MediaSizes {
            screen_width: 3024.0,
            screen_height: 1964.0,
            camera: Some((1280.0, 720.0, 9.0)),
        }
    }

    #[test]
    fn padded_stage_with_background_draws_shadow_and_face_cam() {
        let builder = SceneBuilder::new(doc(), true, 1920.0, 1080.0, media());
        let scene = builder.frame(1.0, &Square);
        assert_eq!(scene.background_darkness, Some(0.15));
        let screen = scene.screen.unwrap();
        // 120 px device padding on a 16:9 stage letterboxes the 1.54 recording.
        assert!((screen.dest.y - 120.0).abs() < 1e-9);
        assert!((screen.dest.height - 840.0).abs() < 1e-9);
        assert_eq!(screen.radius, 18.0);
        assert!(scene.recording_shadow.is_some());
        let face = scene.face_cam.unwrap();
        assert_eq!((face.width, face.height), (400.0, 300.0));
        assert!(face.mirrored);
        assert_eq!(scene.camera, CameraTransform::IDENTITY);
    }

    #[test]
    fn no_background_means_black_backdrop_and_no_shadow() {
        let builder = SceneBuilder::new(doc(), false, 1920.0, 1080.0, media());
        let scene = builder.frame(1.0, &Square);
        assert_eq!(scene.background_darkness, None);
        assert!(scene.recording_shadow.is_none());
    }

    #[test]
    fn cursor_follows_the_recorded_track() {
        let mut d = doc();
        d.recording_metadata = Some(RecordingMetadata {
            source_width: 3024.0,
            source_height: 1964.0,
            cursor_samples: (0..600)
                .map(|i| CursorSample {
                    t: f64::from(i) / 60.0,
                    x: 0.2 + f64::from(i) / 1000.0,
                    y: 0.5,
                    shape: None,
                })
                .collect(),
            ..Default::default()
        });
        d.source_video_size = Size {
            width: 3024.0,
            height: 1964.0,
        };
        let builder = SceneBuilder::new(d, true, 1920.0, 1080.0, media());
        let cursor = builder.frame(2.0, &Square).cursor.unwrap();
        let head = cursor.sprites.last().unwrap();
        let rect = builder.recording_rect();
        let target_x = rect.x + 0.32 * rect.width;
        // A near-critically damped spring trails a constant-velocity target by
        // ≈ 2ζv/ω: smoothness 0.45 gives ω ≈ 21.8 rad/s, ζ ≈ 0.975, and the
        // track moves at 0.06 · rect.width px/s.
        let v = 0.06 * rect.width;
        let expected_lag = 2.0 * 0.975 * v / 21.8;
        let lag = target_x - head.tip_x;
        assert!(lag > 0.0, "the cursor trails, never leads");
        assert!(
            (lag - expected_lag).abs() < 1.0,
            "lag {lag} vs {expected_lag}"
        );
        assert!((head.alpha - 0.95).abs() < 1e-9);
    }
}
