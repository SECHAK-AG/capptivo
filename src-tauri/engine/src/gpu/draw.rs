//! The per-draw uniform shared by every layer (`shaders/compose.wgsl`).

use bytemuck::{Pod, Zeroable};

use super::Affine;
use crate::layout::ShadowPass;
use crate::math::Rect;
use crate::media::{ColorInfo, YuvMatrix};

/// Uniform stride: one draw per 256-byte block, the dynamic-offset alignment
/// every backend accepts.
pub const DRAW_STRIDE: u64 = 256;

/// Most shadow passes one draw evaluates (the recording stack has three).
pub const MAX_SHADOW_PASSES: usize = 3;

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawMode {
    Solid = 0,
    Texture = 1,
    Video = 2,
    Shadow = 3,
    Ring = 4,
}

/// Mirrors `struct Draw` in `compose.wgsl` field for field.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct DrawUniform {
    quad_x: [f32; 4],
    quad_t: [f32; 4],
    space_x: [f32; 4],
    space_t: [f32; 4],
    local_size: [f32; 2],
    radius: f32,
    mode: u32,
    uv_rect: [f32; 4],
    color: [f32; 4],
    opacity: f32,
    yuv_matrix: u32,
    yuv_full_range: u32,
    clip_enabled: u32,
    clip_rect: [f32; 4],
    clip_radius: f32,
    shadow_count: u32,
    _pad0: f32,
    _pad1: f32,
    shadow_rect: [f32; 4],
    shadow_radius: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
    shadow_pass: [[f32; 4]; MAX_SHADOW_PASSES],
    ring: [f32; 4],
}

const _: () = assert!(std::mem::size_of::<DrawUniform>() as u64 == DRAW_STRIDE);

impl DrawUniform {
    /// A quad mapped by `quad` (unit square → draw space) and drawn through
    /// `space` (draw space → clip), `local_size` px in its own frame.
    fn base(mode: DrawMode, quad: Affine, space: Affine, local_size: (f64, f64)) -> Self {
        let (quad_x, quad_t) = quad.columns();
        let (space_x, space_t) = space.columns();
        Self {
            quad_x,
            quad_t,
            space_x,
            space_t,
            local_size: [local_size.0 as f32, local_size.1 as f32],
            radius: 0.0,
            mode: mode as u32,
            uv_rect: [0.0, 0.0, 1.0, 1.0],
            color: [1.0, 1.0, 1.0, 1.0],
            opacity: 1.0,
            ..Zeroable::zeroed()
        }
    }

    /// Axis-aligned rect in draw space.
    fn rect(mode: DrawMode, rect: Rect, space: Affine) -> Self {
        Self::base(
            mode,
            Affine::rect(rect.x, rect.y, rect.width, rect.height),
            space,
            (rect.width, rect.height),
        )
    }

    /// Solid premultiplied colour, optionally rounded.
    pub fn solid(rect: Rect, space: Affine, rgba_premultiplied: [f64; 4], radius: f64) -> Self {
        let mut d = Self::rect(DrawMode::Solid, rect, space);
        d.color = rgba_premultiplied.map(|c| c as f32);
        d.radius = radius as f32;
        d
    }

    /// A premultiplied texture over `rect`, sampling `uv` (normalized).
    pub fn texture(rect: Rect, space: Affine, uv: Rect, alpha: f64) -> Self {
        let mut d = Self::rect(DrawMode::Texture, rect, space);
        d.uv_rect = rect_f32(uv);
        d.color = [alpha as f32; 4];
        d
    }

    /// A texture on an arbitrary quad (rotated cursor glyphs).
    pub fn texture_quad(quad: Affine, local_size: (f64, f64), space: Affine, alpha: f64) -> Self {
        let mut d = Self::base(DrawMode::Texture, quad, space, local_size);
        d.color = [alpha as f32; 4];
        d
    }

    /// An NV12 frame over `rect`, sampling `uv`, rounded by `radius`.
    pub fn video(rect: Rect, space: Affine, uv: Rect, radius: f64, color: ColorInfo) -> Self {
        let mut d = Self::rect(DrawMode::Video, rect, space);
        d.uv_rect = rect_f32(uv);
        d.radius = radius as f32;
        d.yuv_matrix = match color.matrix {
            YuvMatrix::Bt601 => 0,
            YuvMatrix::Bt709 => 1,
            YuvMatrix::Bt2020 => 2,
        };
        d.yuv_full_range = u32::from(color.full_range);
        d
    }

    /// Flip the sampled image horizontally (mirrored face-cam).
    pub fn mirrored(mut self) -> Self {
        let [x, y, w, h] = self.uv_rect;
        self.uv_rect = [x + w, y, -w, h];
        self
    }

    /// Analytic drop shadow of `shadow` (in quad-local px, quad at `quad`).
    pub fn shadow(
        quad: Rect,
        space: Affine,
        shadow: Rect,
        radius: f64,
        passes: &[ShadowPass],
    ) -> Self {
        let mut d = Self::rect(DrawMode::Shadow, quad, space);
        d.shadow_rect = [
            (shadow.x - quad.x) as f32,
            (shadow.y - quad.y) as f32,
            shadow.width as f32,
            shadow.height as f32,
        ];
        d.shadow_radius = radius as f32;
        let live: Vec<&ShadowPass> = passes
            .iter()
            .filter(|p| p.opacity > 0.0 && p.sigma >= 0.0)
            .take(MAX_SHADOW_PASSES)
            .collect();
        d.shadow_count = live.len() as u32;
        for (slot, pass) in d.shadow_pass.iter_mut().zip(live) {
            *slot = [
                pass.sigma as f32,
                pass.opacity as f32,
                pass.offset_x as f32,
                pass.offset_y as f32,
            ];
        }
        d
    }

    /// A circle stroked with `stroke_width` (0 = filled) centred in `quad`.
    pub fn ring(
        quad: Rect,
        space: Affine,
        radius: f64,
        stroke_width: f64,
        rgba_premultiplied: [f64; 4],
    ) -> Self {
        let mut d = Self::rect(DrawMode::Ring, quad, space);
        d.ring = [
            (quad.width / 2.0) as f32,
            (quad.height / 2.0) as f32,
            radius as f32,
            stroke_width as f32,
        ];
        d.color = rgba_premultiplied.map(|c| c as f32);
        d
    }

    /// Clip to a rounded rect given in draw space.
    pub fn clipped(mut self, rect: Rect, radius: f64) -> Self {
        self.clip_enabled = 1;
        self.clip_rect = rect_f32(rect);
        self.clip_radius = radius as f32;
        self
    }
}

fn rect_f32(r: Rect) -> [f32; 4] {
    [r.x as f32, r.y as f32, r.width as f32, r.height as f32]
}
