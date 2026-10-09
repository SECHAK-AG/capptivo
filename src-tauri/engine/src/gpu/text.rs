//! Captions: `captions/drawCaptions.ts` on the GPU (glyphon / cosmic-text).
//!
//! Layout follows the editor exactly — the same wrap rule, block padding,
//! line gap, karaoke word box and "middle" baseline — with widths measured by
//! cosmic-text instead of Canvas2D. Fonts: Inter and Poppins ship with the
//! engine (the editor loads the same faces from Google Fonts); "System UI" and
//! "Monospace" resolve to the platform's own faces.

use std::collections::HashMap;

use glyphon::{
    cosmic_text::Weight, Attrs, Buffer, Cache, Color, ColorMode, Family, FontSystem, Metrics,
    Resolution, Shaping, SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport,
};

use super::draw::DrawUniform;
use super::Affine;
use crate::color::{parse_css_color, premultiply, Rgba};
use crate::document::CaptionSettings;
use crate::error::{EngineError, Result};
use crate::math::{js_max, js_min, js_round, Rect};
use crate::scene::CaptionsDraw;
use crate::timeline::captions::{CaptionTrack, TimedWord};

static INTER_SEMIBOLD: &[u8] = include_bytes!("../../assets/fonts/Inter-SemiBold.ttf");
static POPPINS_SEMIBOLD: &[u8] = include_bytes!("../../assets/fonts/Poppins-SemiBold.ttf");

const SYSTEM_UI_FAMILIES: &[&str] = &[
    // macOS
    "SF Pro",
    "SF Pro Text",
    "System Font",
    ".AppleSystemUIFont",
    "Helvetica Neue",
    // Windows
    "Segoe UI",
    // Linux
    "Ubuntu",
    "Cantarell",
    "Noto Sans",
    "DejaVu Sans",
];

const MONOSPACE_FAMILIES: &[&str] = &[
    "SF Mono",
    "Menlo",
    "Monaco",
    "Consolas",
    "Cascadia Mono",
    "DejaVu Sans Mono",
    "Ubuntu Mono",
    "Noto Sans Mono",
];

/// Resolved, parsed caption style.
struct Style {
    family: FamilyChoice,
    font_size: f64,
    text_color: Rgba,
    word_text_color: Option<Rgba>,
    sentence_background: Option<Rgba>,
    word_background: Option<Rgba>,
    sentence_radius: f64,
    word_radius: f64,
    bottom_offset: f64,
    word_highlight: bool,
}

#[derive(Clone, Copy)]
enum FamilyChoice {
    Inter,
    Poppins,
    SansSerif,
    Monospace,
}

impl FamilyChoice {
    fn from_css(css: &str) -> Self {
        let lower = css.to_ascii_lowercase();
        if lower.contains("poppins") {
            Self::Poppins
        } else if lower.contains("inter") {
            Self::Inter
        } else if lower.contains("mono") || lower.contains("menlo") || lower.contains("consolas") {
            Self::Monospace
        } else {
            Self::SansSerif
        }
    }

    fn family(self) -> Family<'static> {
        match self {
            Self::Inter => Family::Name("Inter"),
            Self::Poppins => Family::Name("Poppins"),
            Self::SansSerif => Family::SansSerif,
            Self::Monospace => Family::Monospace,
        }
    }
}

/// One word placed in its line, text pre-shaped.
struct LaidWord {
    buffer: Buffer,
    width: f64,
}

/// The time-independent layout of one cue (`CaptionLayout`).
struct CueLayout {
    lines: Vec<Vec<LaidWord>>,
    line_widths: Vec<f64>,
    block_inner_width: f64,
    space_width: f64,
}

pub struct CaptionRenderer {
    font_system: FontSystem,
    swash: SwashCache,
    viewport: Viewport,
    atlas: TextAtlas,
    renderer: TextRenderer,
    style: Style,
    stage: (f64, f64),
    output: (u32, u32),
    output_scale: f64,
    layouts: HashMap<usize, CueLayout>,
    measure_cache: HashMap<String, f64>,
    prepared: Option<(usize, isize)>,
    has_text: bool,
}

impl CaptionRenderer {
    /// `stage` is the composition size; `output_scale` maps it to `output` px.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        settings: &CaptionSettings,
        stage: (f64, f64),
        output: (u32, u32),
        output_scale: f64,
    ) -> Result<Self> {
        let mut font_system = FontSystem::new();
        let db = font_system.db_mut();
        db.load_font_data(INTER_SEMIBOLD.to_vec());
        db.load_font_data(POPPINS_SEMIBOLD.to_vec());
        let has_family = |db: &glyphon::fontdb::Database, name: &str| {
            db.faces()
                .any(|face| face.families.iter().any(|(family, _)| family == name))
        };
        if let Some(name) = SYSTEM_UI_FAMILIES.iter().find(|n| has_family(db, n)) {
            db.set_sans_serif_family(*name);
        }
        if let Some(name) = MONOSPACE_FAMILIES.iter().find(|n| has_family(db, n)) {
            db.set_monospace_family(*name);
        }

        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut atlas = TextAtlas::with_color_mode(device, queue, &cache, format, ColorMode::Web);
        let renderer =
            TextRenderer::new(&mut atlas, device, wgpu::MultisampleState::default(), None);
        let color = |v: &Option<String>| v.as_deref().and_then(parse_css_color);
        let style = Style {
            family: FamilyChoice::from_css(&settings.font_family),
            font_size: settings.font_size_px,
            text_color: parse_css_color(&settings.text_color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
            word_text_color: color(&settings.word_text_color),
            sentence_background: color(&settings.sentence_background),
            word_background: color(&settings.word_background),
            sentence_radius: js_max(0.0, settings.sentence_radius_px),
            word_radius: js_max(0.0, settings.word_radius_px),
            bottom_offset: settings.bottom_offset_px,
            word_highlight: settings.word_highlight,
        };
        if style.font_size <= 0.0 || !style.font_size.is_finite() {
            return Err(EngineError::Document(format!(
                "caption font size {}",
                settings.font_size_px
            )));
        }
        Ok(Self {
            font_system,
            swash: SwashCache::new(),
            viewport,
            atlas,
            renderer,
            style,
            stage,
            output,
            output_scale,
            layouts: HashMap::new(),
            measure_cache: HashMap::new(),
            prepared: None,
            has_text: false,
        })
    }

    fn attrs(&self) -> Attrs<'static> {
        Attrs::new()
            .family(self.style.family.family())
            .weight(Weight::SEMIBOLD)
    }

    fn metrics(&self) -> Metrics {
        // Line box = font size, so its centre is the canvas "middle" baseline.
        let size = self.style.font_size as f32;
        Metrics::new(size, size)
    }

    fn shaped(&mut self, text: &str) -> Buffer {
        let metrics = self.metrics();
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_size(None, None);
        buffer.set_text(text, &self.attrs(), Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);
        buffer
    }

    /// Advance width of `text` (`ctx.measureText(text).width`).
    fn measure(&mut self, text: &str) -> f64 {
        if let Some(width) = self.measure_cache.get(text) {
            return *width;
        }
        let buffer = self.shaped(text);
        let width = buffer
            .layout_runs()
            .map(|run| f64::from(run.line_w))
            .sum::<f64>();
        self.measure_cache.insert(text.to_string(), width);
        width
    }

    fn display_text(word: &TimedWord, with_leading_space: bool) -> String {
        if with_leading_space && word.leading_space {
            format!(" {}", word.text)
        } else {
            word.text.clone()
        }
    }

    /// `measureLineWidth`.
    fn line_width(&mut self, words: &[TimedWord], space_width: f64) -> f64 {
        let mut width = 0.0;
        for (i, word) in words.iter().enumerate() {
            width += self.measure(&Self::display_text(word, i > 0));
            if i + 1 < words.len() {
                width += space_width;
            }
        }
        width
    }

    /// `getCaptionLayout` + `wrapPhraseToLines`.
    fn layout(&mut self, words: &[TimedWord]) -> CueLayout {
        let space_width = self.measure(" ");
        let max_line_width = js_max(120.0, js_min(self.stage.0 * 0.86, self.stage.0 - 32.0));

        let mut lines: Vec<Vec<TimedWord>> = Vec::new();
        let mut line: Vec<TimedWord> = Vec::new();
        for word in words {
            let mut trial = line.clone();
            trial.push(word.clone());
            // Wrapping measures every word after the first with a space.
            let forced: Vec<TimedWord> = trial
                .iter()
                .enumerate()
                .map(|(i, w)| TimedWord {
                    leading_space: i > 0,
                    ..w.clone()
                })
                .collect();
            let trial_width = self.line_width(&forced, space_width);
            if trial_width <= max_line_width || line.is_empty() {
                line = trial;
            } else {
                lines.push(std::mem::take(&mut line));
                line = vec![word.clone()];
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }

        let line_widths: Vec<f64> = lines
            .iter()
            .map(|l| self.line_width(l, space_width))
            .collect();
        let block_inner_width = line_widths.iter().copied().fold(0.0, f64::max);
        let laid = lines
            .iter()
            .map(|l| {
                l.iter()
                    .enumerate()
                    .map(|(i, w)| {
                        let text = Self::display_text(w, i > 0);
                        LaidWord {
                            width: self.measure(&text),
                            buffer: self.shaped(&text),
                        }
                    })
                    .collect()
            })
            .collect();
        CueLayout {
            lines: laid,
            line_widths,
            block_inner_width,
            space_width,
        }
    }

    /// Lay out this frame's caption: background boxes are appended to `draws`
    /// (drawn in `stage_space`), text is prepared for [`Self::render`].
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        track: &CaptionTrack,
        frame: Option<&CaptionsDraw>,
        stage_space: Affine,
        draws: &mut Vec<DrawUniform>,
    ) -> Result<()> {
        let Some(frame) = frame else {
            self.has_text = false;
            return Ok(());
        };
        let Some((cue, timed)) = track.cue(frame.cue_index) else {
            self.has_text = false;
            return Ok(());
        };
        let fallback: Vec<TimedWord>;
        let layout_words: &[TimedWord] = if timed.is_empty() {
            fallback = cue
                .text
                .split_whitespace()
                .enumerate()
                .map(|(i, text)| TimedWord {
                    text: text.to_string(),
                    start_sec: 0.0,
                    end_sec: 0.0,
                    leading_space: i > 0,
                })
                .collect();
            &fallback
        } else {
            timed
        };
        if layout_words.is_empty() {
            self.has_text = false;
            return Ok(());
        }
        if !self.layouts.contains_key(&frame.cue_index) {
            let layout = self.layout(layout_words);
            self.layouts.insert(frame.cue_index, layout);
        }

        let style = &self.style;
        let karaoke = style.word_highlight
            && style.word_background.is_some()
            && !timed.is_empty()
            && frame.active_word_index >= 0;
        let fs = style.font_size;
        let line_gap = js_round(fs * 0.2);
        let line_height = js_round(fs * 1.28);
        let pad_x = js_max(14.0, js_round(fs * 0.42));
        let pad_y = js_max(10.0, js_round(fs * 0.32));
        let layout = &self.layouts[&frame.cue_index];
        let n = layout.lines.len() as f64;
        let block_w = layout.block_inner_width + pad_x * 2.0;
        let block_h = n * line_height + (n - 1.0) * line_gap + pad_y * 2.0;
        let block_left = (self.stage.0 - block_w) / 2.0;
        let block_top = self.stage.1 - style.bottom_offset - block_h;

        if let Some(bg) = style.sentence_background {
            draws.push(DrawUniform::solid(
                Rect::new(block_left, block_top, block_w, block_h),
                stage_space,
                premultiply(bg),
                style.sentence_radius,
            ));
        }

        // Positions in composition px, then scaled to the output.
        struct Placed {
            line: usize,
            word: usize,
            x: f64,
            mid_y: f64,
            active: bool,
        }
        let mut placed = Vec::new();
        let mut flat = 0isize;
        for (li, words) in layout.lines.iter().enumerate() {
            let line_top = block_top + pad_y + li as f64 * (line_height + line_gap);
            let mid_y = line_top + line_height * 0.5;
            let mut x = block_left + (block_w - layout.line_widths[li]) / 2.0;
            for (wi, word) in words.iter().enumerate() {
                let active = karaoke && flat == frame.active_word_index;
                if active {
                    if let Some(bg) = style.word_background {
                        let pad_wx = js_max(3.0, fs * 0.12);
                        let word_h = line_height * 0.88;
                        draws.push(DrawUniform::solid(
                            Rect::new(
                                x - pad_wx,
                                mid_y - word_h * 0.5,
                                word.width + pad_wx * 2.0,
                                word_h,
                            ),
                            stage_space,
                            premultiply(bg),
                            style.word_radius,
                        ));
                    }
                }
                placed.push(Placed {
                    line: li,
                    word: wi,
                    x,
                    mid_y,
                    active,
                });
                x += word.width + layout.space_width;
                flat += 1;
            }
        }

        let key = (
            frame.cue_index,
            if karaoke { frame.active_word_index } else { -1 },
        );
        if self.prepared == Some(key) && self.has_text {
            return Ok(());
        }
        self.viewport.update(
            queue,
            Resolution {
                width: self.output.0,
                height: self.output.1,
            },
        );
        let to_u8 = |c: Rgba| {
            let b = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            Color::rgba(b(c[0]), b(c[1]), b(c[2]), b(c[3]))
        };
        let base_color = to_u8(style.text_color);
        let active_color = to_u8(style.word_text_color.unwrap_or(style.text_color));
        let scale = self.output_scale;
        let bounds = TextBounds {
            left: 0,
            top: 0,
            right: self.output.0 as i32,
            bottom: self.output.1 as i32,
        };
        let areas = placed.iter().map(|p| TextArea {
            buffer: &layout.lines[p.line][p.word].buffer,
            left: (p.x * scale) as f32,
            top: ((p.mid_y - fs / 2.0) * scale) as f32,
            scale: scale as f32,
            bounds,
            default_color: if p.active { active_color } else { base_color },
            custom_glyphs: &[],
        });
        self.renderer
            .prepare(
                device,
                queue,
                &mut self.font_system,
                &mut self.atlas,
                &self.viewport,
                areas,
                &mut self.swash,
            )
            .map_err(|e| EngineError::Gpu(format!("caption text: {e}")))?;
        self.prepared = Some(key);
        self.has_text = true;
        Ok(())
    }

    /// Draw the prepared text (after the caption boxes).
    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) -> Result<()> {
        if !self.has_text {
            return Ok(());
        }
        self.renderer
            .render(&self.atlas, &self.viewport, pass)
            .map_err(|e| EngineError::Gpu(format!("caption text: {e}")))
    }
}
