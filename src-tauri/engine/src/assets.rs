//! Static inputs prepared once per job: cursor glyphs and the background.
//!
//! Cursor glyphs are the editor's own SVGs (`public/cursors`, embedded at
//! build time) rasterized the way `engine/cursorOverlay.ts` does it: 256 px
//! tall, optionally inverted, trimmed to their visible pixels with the hotspot
//! remapped into the trimmed box.

use std::collections::HashMap;

use image::RgbaImage;

use crate::document::{CursorShape, CursorStyle};
use crate::error::{EngineError, Result};
use crate::layout::cover_dest_rect;
use crate::math::{clamp, js_round};
use crate::scene::GlyphAspect;
use crate::timeline::cursor::cursor_asset_spec;

/// Raster height for cursor glyphs (`RASTER_HEIGHT`).
const RASTER_HEIGHT: u32 = 256;
/// Pixels with alpha at or below this are trimmed away (`trimToContent`).
const TRIM_ALPHA: u8 = 8;

macro_rules! cursor_svgs {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_bytes!(concat!("../../../public/cursors/", $path)) as &[u8])),*]
    };
}

static CURSOR_SVGS: &[(&str, &[u8])] = cursor_svgs![
    "minimal.svg",
    "macos/arrow.svg",
    "macos/pointer.svg",
    "macos/text.svg",
    "macos/open-hand.svg",
    "macos/closed-hand.svg",
    "macos/crosshair.svg",
    "macos/resize-ew.svg",
    "macos/resize-ns.svg",
    "macos/resize-nesw.svg",
    "macos/resize-nwse.svg",
    "macos/not-allowed.svg",
    "macos/alias.svg",
    "macos/copy.svg",
    "macos/context-menu.svg",
    "tahoe/arrow.svg",
    "tahoe/pointer.svg",
    "tahoe/text.svg",
    "tahoe/open-hand.svg",
    "tahoe/closed-hand.svg",
    "tahoe/crosshair.svg",
    "tahoe/resize-ew.svg",
    "tahoe/resize-ns.svg",
    "tahoe/resize-nesw.svg",
    "tahoe/resize-nwse.svg",
    "tahoe/not-allowed.svg",
    "tahoe/alias.svg",
    "tahoe/copy.svg",
    "tahoe/context-menu.svg",
];

/// One rasterized cursor glyph, premultiplied RGBA with its mip chain.
#[derive(Debug, Clone)]
pub struct GlyphRaster {
    pub width: u32,
    pub height: u32,
    /// Level 0 first; each level halves (rounding up) down to 1×1.
    pub mips: Vec<Vec<u8>>,
    /// Hotspot as a fraction of the trimmed raster.
    pub anchor: (f64, f64),
}

/// Every glyph one cursor style can replay.
#[derive(Debug, Clone)]
pub struct CursorGlyphs {
    glyphs: HashMap<CursorShape, GlyphRaster>,
}

impl CursorGlyphs {
    pub fn load(style: CursorStyle) -> Result<Self> {
        let mut cache: HashMap<(&'static str, bool), GlyphRaster> = HashMap::new();
        let mut glyphs = HashMap::new();
        for shape in CursorShape::ALL {
            let spec = cursor_asset_spec(style, shape);
            let raster = match cache.get(&(spec.file, spec.invert)) {
                Some(raster) => raster.clone(),
                None => {
                    let raster = rasterize_cursor(spec.file, spec.hotspot, spec.invert)?;
                    cache.insert((spec.file, spec.invert), raster.clone());
                    raster
                }
            };
            glyphs.insert(shape, raster);
        }
        Ok(Self { glyphs })
    }

    pub fn get(&self, shape: CursorShape) -> &GlyphRaster {
        self.glyphs
            .get(&shape)
            .unwrap_or_else(|| &self.glyphs[&CursorShape::Default])
    }

    pub fn iter(&self) -> impl Iterator<Item = (CursorShape, &GlyphRaster)> {
        self.glyphs.iter().map(|(shape, raster)| (*shape, raster))
    }
}

impl GlyphAspect for CursorGlyphs {
    fn aspect(&self, shape: CursorShape) -> f64 {
        let g = self.get(shape);
        f64::from(g.width) / f64::from(g.height)
    }
}

fn rasterize_cursor(file: &str, hotspot: (f64, f64), invert: bool) -> Result<GlyphRaster> {
    let data = CURSOR_SVGS
        .iter()
        .find(|(path, _)| *path == file)
        .map(|(_, bytes)| *bytes)
        .ok_or_else(|| EngineError::Asset(format!("missing cursor {file}")))?;
    let tree = resvg::usvg::Tree::from_data(data, &resvg::usvg::Options::default())
        .map_err(|e| EngineError::Asset(format!("cursor {file}: {e}")))?;
    let size = tree.size();
    let (src_w, src_h) = (
        f64::from(size.width()).max(1.0),
        f64::from(size.height()).max(1.0),
    );
    let height = RASTER_HEIGHT;
    let width = (js_round(src_w / src_h * f64::from(height)) as u32).max(1);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| EngineError::Asset(format!("cursor {file}: bad size")))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(
            width as f32 / src_w as f32,
            height as f32 / src_h as f32,
        ),
        &mut pixmap.as_mut(),
    );
    let mut rgba = pixmap.take();
    if invert {
        invert_premultiplied(&mut rgba);
    }
    let (rgba, width, height, anchor) = trim_to_content(rgba, width, height, hotspot);
    Ok(GlyphRaster {
        width,
        height,
        mips: mip_chain(rgba, width, height),
        anchor,
    })
}

/// `255 − c` on the straight colour of every visible pixel, kept premultiplied.
fn invert_premultiplied(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        if a == 0 {
            continue;
        }
        for c in &mut px[..3] {
            let straight = ((u32::from(*c) * 255 + a / 2) / a).min(255);
            *c = (((255 - straight) * a + 127) / 255) as u8;
        }
    }
}

/// Crop to pixels with alpha > 8 plus a 1 px margin, remapping the hotspot.
fn trim_to_content(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    anchor: (f64, f64),
) -> (Vec<u8>, u32, u32, (f64, f64)) {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, 0u32, 0u32);
    let mut any = false;
    for y in 0..height {
        for x in 0..width {
            if rgba[((y * width + x) * 4 + 3) as usize] > TRIM_ALPHA {
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if !any {
        return (rgba, width, height, anchor);
    }
    let min_x = min_x.saturating_sub(1);
    let min_y = min_y.saturating_sub(1);
    let max_x = (max_x + 1).min(width - 1);
    let max_y = (max_y + 1).min(height - 1);
    let (w, h) = (max_x - min_x + 1, max_y - min_y + 1);
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in min_y..=max_y {
        let start = ((y * width + min_x) * 4) as usize;
        out.extend_from_slice(&rgba[start..start + (w * 4) as usize]);
    }
    let anchor = (
        clamp(
            (anchor.0 * f64::from(width) - f64::from(min_x)) / f64::from(w),
            0.0,
            1.0,
        ),
        clamp(
            (anchor.1 * f64::from(height) - f64::from(min_y)) / f64::from(h),
            0.0,
            1.0,
        ),
    );
    (out, w, h, anchor)
}

/// Box-filtered mip chain over premultiplied RGBA (correct for alpha).
/// Level sizes follow the GPU rule `max(1, size >> level)`.
fn mip_chain(level0: Vec<u8>, width: u32, height: u32) -> Vec<Vec<u8>> {
    let mut mips = vec![level0];
    let (mut w, mut h) = (width, height);
    while w > 1 || h > 1 {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let src = mips.last().expect("level 0 exists");
        let mut dst = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                let mut sum = [0u32; 4];
                let mut count = 0;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (sx, sy) = (x * 2 + dx, y * 2 + dy);
                    if sx < w && sy < h {
                        let i = ((sy * w + sx) * 4) as usize;
                        for (c, total) in sum.iter_mut().enumerate() {
                            *total += u32::from(src[i + c]);
                        }
                        count += 1;
                    }
                }
                let i = ((y * nw + x) * 4) as usize;
                for (c, total) in sum.iter().enumerate() {
                    dst[i + c] = ((total + count / 2) / count) as u8;
                }
            }
        }
        mips.push(dst);
        w = nw;
        h = nh;
    }
    mips
}

/// The background covering a `width`×`height` target, premultiplied RGBA
/// (`drawImageCover`: scaled to cover, centred, overflow cropped).
pub fn background_cover(encoded: &[u8], width: u32, height: u32) -> Result<RgbaImage> {
    let image = image::load_from_memory(encoded)
        .map_err(|e| EngineError::Asset(format!("background image: {e}")))?
        .to_rgba8();
    let (iw, ih) = image.dimensions();
    if iw == 0 || ih == 0 {
        return Err(EngineError::Asset("background image is empty".into()));
    }
    let mut image = image;
    for px in image.pixels_mut() {
        let a = u16::from(px[3]);
        for c in 0..3 {
            px[c] = ((u16::from(px[c]) * a + 127) / 255) as u8;
        }
    }
    // Visible part of the source, in source pixels.
    let dest = cover_dest_rect(
        f64::from(iw),
        f64::from(ih),
        f64::from(width),
        f64::from(height),
    );
    let scale = dest.width / f64::from(iw);
    let crop_x = (-dest.x / scale).max(0.0);
    let crop_y = (-dest.y / scale).max(0.0);
    let crop_w = (f64::from(width) / scale).min(f64::from(iw) - crop_x);
    let crop_h = (f64::from(height) / scale).min(f64::from(ih) - crop_y);
    let x0 = crop_x.round() as u32;
    let y0 = crop_y.round() as u32;
    let cw = (crop_w.round() as u32).clamp(1, iw - x0.min(iw - 1));
    let ch = (crop_h.round() as u32).clamp(1, ih - y0.min(ih - 1));
    let cropped = image::imageops::crop_imm(&image, x0, y0, cw, ch).to_image();
    Ok(image::imageops::resize(
        &cropped,
        width,
        height,
        image::imageops::FilterType::Lanczos3,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_style_rasterizes_every_shape() {
        for style in [
            CursorStyle::Macos,
            CursorStyle::Tahoe,
            CursorStyle::TahoeInverted,
            CursorStyle::Figma,
        ] {
            let glyphs = CursorGlyphs::load(style).unwrap();
            for shape in CursorShape::ALL {
                let g = glyphs.get(shape);
                assert!(
                    g.width > 4 && g.height > 4 && g.height <= RASTER_HEIGHT,
                    "{style:?} {shape:?}"
                );
                assert_eq!(g.mips[0].len(), (g.width * g.height * 4) as usize);
                assert!((0.0..=1.0).contains(&g.anchor.0) && (0.0..=1.0).contains(&g.anchor.1));
                assert_eq!(g.mips.last().unwrap().len(), 4, "mips end at 1×1");
                let levels = 32 - g.width.max(g.height).leading_zeros();
                assert_eq!(
                    g.mips.len() as u32,
                    levels,
                    "{style:?} {shape:?}: GPU mip count"
                );
            }
        }
    }

    #[test]
    fn tahoe_arrow_hotspot_sits_on_the_tip() {
        // The arrow's tip is its top-left visible pixel; after trimming the
        // hotspot must be within a few px of that corner.
        let glyphs = CursorGlyphs::load(CursorStyle::Tahoe).unwrap();
        let g = glyphs.get(CursorShape::Default);
        let (ax, ay) = (
            g.anchor.0 * f64::from(g.width),
            g.anchor.1 * f64::from(g.height),
        );
        assert!(
            ax < 40.0 && ay < 30.0,
            "hotspot at {ax},{ay} in {}x{}",
            g.width,
            g.height
        );
    }

    #[test]
    fn inversion_flips_colour_and_keeps_alpha() {
        let mut px = vec![255, 255, 255, 255, 64, 64, 64, 128, 0, 0, 0, 0];
        invert_premultiplied(&mut px);
        assert_eq!(&px[..4], &[0, 0, 0, 255]);
        assert_eq!(px[7], 128);
        assert_eq!(&px[8..], &[0, 0, 0, 0]);
    }

    #[test]
    fn background_covers_the_target() {
        let mut png = Vec::new();
        let img = RgbaImage::from_pixel(400, 100, image::Rgba([10, 20, 30, 255]));
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let cover = background_cover(&png, 160, 90).unwrap();
        assert_eq!(cover.dimensions(), (160, 90));
        assert_eq!(cover.get_pixel(80, 45).0, [10, 20, 30, 255]);
    }
}
