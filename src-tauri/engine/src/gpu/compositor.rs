//! Draws a [`FrameScene`] and converts it to NV12 for the encoder.
//!
//! Everything static (background, cursor glyphs, pipelines) is prepared once;
//! per frame the CPU only writes one uniform block per layer and the two video
//! planes that changed.

use std::collections::HashMap;
use std::sync::Arc;

use super::blur::Blur;
use super::draw::{DrawUniform, DRAW_STRIDE};
use super::nv12::Nv12Readback;
use super::text::CaptionRenderer;
use super::{Affine, GpuContext};
use crate::assets::{background_cover, CursorGlyphs};
use crate::document::{CaptionSettings, CursorShape};
use crate::error::{EngineError, Result};
use crate::layout::CompositionSize;
use crate::math::Rect;
use crate::media::ColorInfo;
use crate::scene::{FrameScene, ShadowDraw, BLUR_REGION_SIGMA, CLICK_FX_RGB};
use crate::timeline::captions::CaptionTrack;

const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Background blur radius (composition px) blurred at full resolution
/// (`backgroundBlurScale`).
const FULL_RES_MAX_BLUR: f64 = 12.0;
const MIN_BLUR_SCALE: f64 = 0.25;
/// Blur-region scratch textures grow in steps of this many pixels.
const SCRATCH_STEP: u32 = 128;

/// One decoded video track's geometry and colour.
#[derive(Debug, Clone, Copy)]
pub struct VideoSpec {
    pub width: u32,
    pub height: u32,
    pub color: ColorInfo,
}

/// What a compositor is built for.
pub struct CompositorConfig<'a> {
    pub output_width: u32,
    pub output_height: u32,
    pub composition: CompositionSize,
    pub screen: VideoSpec,
    pub camera: Option<VideoSpec>,
    /// Encoded background image (PNG/JPEG/WebP), when one is selected.
    pub background: Option<&'a [u8]>,
    /// `look.backgroundBlur`, composition px.
    pub background_blur: f64,
    pub glyphs: Option<&'a CursorGlyphs>,
    pub captions: Option<&'a CaptionSettings>,
    /// Blur regions in the document: bounds the draws per frame.
    pub blur_regions: usize,
    pub readback_slots: usize,
}

/// Draws per frame besides blur regions: background + darkness, recording
/// shadow, screen, up to three click rings, five trail ghosts and two heads,
/// face-cam shadow and video, two caption boxes — with headroom.
const FIXED_DRAWS: u64 = 32;

struct VideoTextures {
    spec: VideoSpec,
    y: wgpu::Texture,
    uv: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}

struct Scratch {
    size: (u32, u32),
    a_view: wgpu::TextureView,
    b_view: wgpu::TextureView,
    bind_a: wgpu::BindGroup,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Bind {
    Plain,
    Background,
    Screen,
    Camera,
    Glyph(CursorShape),
    Scratch(usize),
}

struct Glyph {
    bind_group: wgpu::BindGroup,
    anchor: (f64, f64),
    aspect: f64,
}

pub struct Compositor {
    ctx: Arc<GpuContext>,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    max_draws: u64,
    target_view: wgpu::TextureView,
    dummy_y: wgpu::TextureView,
    dummy_uv: wgpu::TextureView,
    plain: wgpu::BindGroup,
    background: Option<wgpu::BindGroup>,
    screen: VideoTextures,
    camera: Option<VideoTextures>,
    glyphs: HashMap<CursorShape, Glyph>,
    scratch: Vec<Scratch>,
    blur: Blur,
    nv12: Nv12Readback,
    text: Option<CaptionRenderer>,
    output: (u32, u32),
    composition: CompositionSize,
    staging: Vec<u8>,
}

impl Compositor {
    pub fn new(ctx: Arc<GpuContext>, config: CompositorConfig<'_>) -> Result<Self> {
        let device = &ctx.device;
        let (w, h) = (config.output_width, config.output_height);
        let max = device.limits().max_texture_dimension_2d;
        for (what, tw, th) in [
            ("output", w, h),
            ("screen", config.screen.width, config.screen.height),
        ] {
            if tw == 0 || th == 0 || tw > max || th > max {
                return Err(EngineError::Gpu(format!(
                    "{what} size {tw}x{th} exceeds this GPU's {max}px limit"
                )));
            }
        }

        let shader = device.create_shader_module(wgpu::include_wgsl!("shaders/compose.wgsl"));
        let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compose"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(DRAW_STRIDE),
                    },
                    count: None,
                },
                texture_entry(1),
                texture_entry(2),
                texture_entry(3),
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compose"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compose"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: TARGET_FORMAT,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("compose"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let max_draws = FIXED_DRAWS + 2 * config.blur_regions as u64;
        let uniforms = Self::uniform_buffer(device, max_draws);

        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("composite"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TARGET_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let target_view = target.create_view(&Default::default());

        let dummy = |format, bytes: &[u8]| {
            let texture = Self::texture(
                device,
                "dummy",
                1,
                1,
                1,
                format,
                wgpu::TextureUsages::empty(),
            );
            ctx.queue.write_texture(
                texture.as_image_copy(),
                bytes,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes.len() as u32),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
            );
            texture.create_view(&Default::default())
        };
        let dummy_rgba = dummy(wgpu::TextureFormat::Rgba8Unorm, &[0, 0, 0, 0]);
        let dummy_y = dummy(wgpu::TextureFormat::R8Unorm, &[0]);
        let dummy_uv = dummy(wgpu::TextureFormat::Rg8Unorm, &[128, 128]);

        let bind = |rgba: &wgpu::TextureView, y: &wgpu::TextureView, uv: &wgpu::TextureView| {
            Self::bind_group(device, &layout, &uniforms, &sampler, rgba, y, uv)
        };
        let plain = bind(&dummy_rgba, &dummy_y, &dummy_uv);

        let screen = Self::video_textures(
            device,
            &layout,
            &uniforms,
            &sampler,
            &dummy_rgba,
            config.screen,
        );
        let camera = config.camera.map(|spec| {
            Self::video_textures(device, &layout, &uniforms, &sampler, &dummy_rgba, spec)
        });

        let mut glyphs = HashMap::new();
        if let Some(set) = config.glyphs {
            for (shape, raster) in set.iter() {
                let texture = Self::texture(
                    device,
                    "cursor",
                    raster.width,
                    raster.height,
                    raster.mips.len() as u32,
                    wgpu::TextureFormat::Rgba8Unorm,
                    wgpu::TextureUsages::empty(),
                );
                let (mut mw, mut mh) = (raster.width, raster.height);
                for (level, data) in raster.mips.iter().enumerate() {
                    ctx.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &texture,
                            mip_level: level as u32,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        data,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(mw * 4),
                            rows_per_image: None,
                        },
                        wgpu::Extent3d {
                            width: mw,
                            height: mh,
                            depth_or_array_layers: 1,
                        },
                    );
                    mw = (mw / 2).max(1);
                    mh = (mh / 2).max(1);
                }
                let view = texture.create_view(&Default::default());
                glyphs.insert(
                    shape,
                    Glyph {
                        bind_group: bind(&view, &dummy_y, &dummy_uv),
                        anchor: raster.anchor,
                        aspect: f64::from(raster.width) / f64::from(raster.height),
                    },
                );
            }
        }

        let mut blur = Blur::new(device, TARGET_FORMAT);
        let background = match config.background {
            None => None,
            Some(encoded) => {
                let view = Self::background_texture(
                    &ctx,
                    &mut blur,
                    encoded,
                    w,
                    h,
                    config.composition,
                    config.background_blur,
                )?;
                Some(bind(&view, &dummy_y, &dummy_uv))
            }
        };

        let nv12 = Nv12Readback::new(device, &target_view, w, h, config.readback_slots)?;
        let text = match config.captions {
            Some(settings) if settings.enabled => Some(CaptionRenderer::new(
                device,
                &ctx.queue,
                TARGET_FORMAT,
                settings,
                (config.composition.width, config.composition.height),
                (w, h),
                config.composition.output_scale,
            )?),
            _ => None,
        };

        ctx.check()?;
        Ok(Self {
            ctx: ctx.clone(),
            pipeline,
            layout,
            sampler,
            uniforms,
            max_draws,
            target_view,
            dummy_y,
            dummy_uv,
            plain,
            background,
            screen,
            camera,
            glyphs,
            scratch: Vec::new(),
            blur,
            nv12,
            text,
            output: (w, h),
            composition: config.composition,
            staging: Vec::new(),
        })
    }

    fn uniform_buffer(device: &wgpu::Device, draws: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("draw uniforms"),
            size: draws * DRAW_STRIDE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn texture(
        device: &wgpu::Device,
        label: &str,
        width: u32,
        height: u32,
        mips: u32,
        format: wgpu::TextureFormat,
        extra: wgpu::TextureUsages,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: mips,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | extra,
            view_formats: &[],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        uniforms: &wgpu::Buffer,
        sampler: &wgpu::Sampler,
        rgba: &wgpu::TextureView,
        y: &wgpu::TextureView,
        uv: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("compose"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: uniforms,
                        offset: 0,
                        size: wgpu::BufferSize::new(DRAW_STRIDE),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(rgba),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(y),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(uv),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    fn video_textures(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        uniforms: &wgpu::Buffer,
        sampler: &wgpu::Sampler,
        dummy_rgba: &wgpu::TextureView,
        spec: VideoSpec,
    ) -> VideoTextures {
        let y = Self::texture(
            device,
            "video y",
            spec.width,
            spec.height,
            1,
            wgpu::TextureFormat::R8Unorm,
            wgpu::TextureUsages::empty(),
        );
        let uv = Self::texture(
            device,
            "video uv",
            spec.width / 2,
            spec.height / 2,
            1,
            wgpu::TextureFormat::Rg8Unorm,
            wgpu::TextureUsages::empty(),
        );
        let bind_group = Self::bind_group(
            device,
            layout,
            uniforms,
            sampler,
            dummy_rgba,
            &y.create_view(&Default::default()),
            &uv.create_view(&Default::default()),
        );
        VideoTextures {
            spec,
            y,
            uv,
            bind_group,
        }
    }

    /// Cover-fit the background at output resolution and blur it once, the
    /// way `renderBackgroundToCache` does (large radii blur at reduced size).
    fn background_texture(
        ctx: &GpuContext,
        blur: &mut Blur,
        encoded: &[u8],
        width: u32,
        height: u32,
        composition: CompositionSize,
        blur_px: f64,
    ) -> Result<wgpu::TextureView> {
        let blur_px = blur_px.max(0.0);
        let scale = if blur_px <= FULL_RES_MAX_BLUR {
            1.0
        } else {
            (FULL_RES_MAX_BLUR / blur_px).max(MIN_BLUR_SCALE)
        };
        let ww = ((f64::from(width) * scale).round() as u32).max(1);
        let wh = ((f64::from(height) * scale).round() as u32).max(1);
        let image = background_cover(encoded, ww, wh)?;
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT;
        let device = &ctx.device;
        let a = Self::texture(
            device,
            "background",
            ww,
            wh,
            1,
            wgpu::TextureFormat::Rgba8Unorm,
            usage,
        );
        ctx.queue.write_texture(
            a.as_image_copy(),
            image.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ww * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: ww,
                height: wh,
                depth_or_array_layers: 1,
            },
        );
        let a_view = a.create_view(&Default::default());
        if blur_px > 0.0 {
            let b = Self::texture(
                device,
                "background blur",
                ww,
                wh,
                1,
                wgpu::TextureFormat::Rgba8Unorm,
                usage,
            );
            let b_view = b.create_view(&Default::default());
            let sigma = (blur_px * composition.output_scale * scale) as f32;
            let mut encoder = device.create_command_encoder(&Default::default());
            blur.pass(
                device,
                &ctx.queue,
                &mut encoder,
                &a_view,
                &b_view,
                true,
                sigma,
            );
            blur.pass(
                device,
                &ctx.queue,
                &mut encoder,
                &b_view,
                &a_view,
                false,
                sigma,
            );
            ctx.queue.submit([encoder.finish()]);
        }
        Ok(a_view)
    }

    pub fn output_size(&self) -> (u32, u32) {
        self.output
    }

    pub fn readback_slots(&self) -> usize {
        self.nv12.slot_count()
    }

    pub fn frame_len(&self) -> usize {
        self.nv12.frame_len()
    }

    pub fn glyph_aspect(&self, shape: CursorShape) -> f64 {
        self.glyphs.get(&shape).map_or(1.0, |g| g.aspect)
    }

    /// Replace the screen frame (NV12, tightly packed).
    pub fn upload_screen(&self, nv12: &[u8]) -> Result<()> {
        self.upload(&self.screen, nv12)
    }

    /// Replace the camera frame (NV12, tightly packed).
    pub fn upload_camera(&self, nv12: &[u8]) -> Result<()> {
        match &self.camera {
            Some(camera) => self.upload(camera, nv12),
            None => Err(EngineError::Gpu("no camera track".into())),
        }
    }

    fn upload(&self, video: &VideoTextures, nv12: &[u8]) -> Result<()> {
        let (w, h) = (video.spec.width, video.spec.height);
        let luma = (w * h) as usize;
        if nv12.len() != luma + luma / 2 {
            return Err(EngineError::Gpu(format!(
                "NV12 frame is {} bytes, want {}",
                nv12.len(),
                luma + luma / 2
            )));
        }
        let queue = &self.ctx.queue;
        queue.write_texture(
            video.y.as_image_copy(),
            &nv12[..luma],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.write_texture(
            video.uv.as_image_copy(),
            &nv12[luma..],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: w / 2,
                height: h / 2,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    /// Draw `scene` and queue its NV12 conversion into readback `slot`.
    /// The frame is collected later with [`Self::collect`].
    pub fn render(
        &mut self,
        scene: &FrameScene,
        captions: &CaptionTrack,
        slot: usize,
    ) -> Result<()> {
        if self.nv12.is_pending(slot) {
            return Err(EngineError::Gpu(format!(
                "readback slot {slot} is still in use"
            )));
        }
        let (w, h) = (f64::from(self.output.0), f64::from(self.output.1));
        let s_o = self.composition.output_scale;
        let to_clip = Affine::pixels_to_clip(w, h);
        let to_output = Affine::scale(s_o, s_o);
        let stage = to_clip.then_after(to_output);
        let cam = Affine {
            m: [scene.camera.scale, 0.0, 0.0, scene.camera.scale],
            t: [scene.camera.x, scene.camera.y],
        };
        let camera_space = stage.then_after(cam);
        let cam_to_output = to_output.then_after(cam);

        let mut draws: Vec<(DrawUniform, Bind)> = Vec::with_capacity(32);
        // Offscreen passes for blur regions: (scratch index, prep draw index).
        let mut region_jobs: Vec<(usize, usize, f32)> = Vec::new();

        // Background.
        let comp = Rect::new(0.0, 0.0, self.composition.width, self.composition.height);
        // Without a background, the pass's clear colour is the black backdrop.
        if let (Some(darkness), Some(_)) = (scene.background_darkness, &self.background) {
            draws.push((
                DrawUniform::texture(comp, stage, Rect::new(0.0, 0.0, 1.0, 1.0), 1.0),
                Bind::Background,
            ));
            if darkness > 0.0 {
                draws.push((
                    DrawUniform::solid(comp, stage, [0.0, 0.0, 0.0, darkness], 0.0),
                    Bind::Plain,
                ));
            }
        }

        // Camera group: shadow, screen, blur regions, cursor.
        if let Some(shadow) = &scene.recording_shadow {
            draws.push((shadow_draw(shadow, camera_space), Bind::Plain));
        }
        if let Some(screen) = &scene.screen {
            let spec = self.screen.spec;
            let uv = Rect::new(
                screen.source.x / f64::from(spec.width),
                screen.source.y / f64::from(spec.height),
                screen.source.width / f64::from(spec.width),
                screen.source.height / f64::from(spec.height),
            );
            draws.push((
                DrawUniform::video(screen.dest, camera_space, uv, screen.radius, spec.color),
                Bind::Screen,
            ));

            let clip = transform_rect(cam_to_output, screen.dest);
            let clip_radius = screen.radius * scene.camera.scale * s_o;
            let sigma = BLUR_REGION_SIGMA * s_o;
            let pad = (sigma * 3.0).ceil();
            for (index, region) in scene.blur_regions.iter().enumerate() {
                let dest = transform_rect(cam_to_output, region.dest);
                let (ox, oy) = (dest.x.floor(), dest.y.floor());
                let (fx, fy) = (dest.x - ox, dest.y - oy);
                let used_w = (fx + dest.width).ceil() + pad * 2.0;
                let used_h = (fy + dest.height).ceil() + pad * 2.0;
                let size = self.ensure_scratch(index, used_w as u32, used_h as u32);
                let scratch_space = Affine::pixels_to_clip(f64::from(size.0), f64::from(size.1));
                let source_uv = Rect::new(
                    region.source.x / f64::from(spec.width),
                    region.source.y / f64::from(spec.height),
                    region.source.width / f64::from(spec.width),
                    region.source.height / f64::from(spec.height),
                );
                let prep = DrawUniform::video(
                    Rect::new(pad + fx, pad + fy, dest.width, dest.height),
                    scratch_space,
                    source_uv,
                    0.0,
                    spec.color,
                );
                region_jobs.push((index, draws.len(), sigma as f32));
                draws.push((prep, Bind::Screen));
                let final_draw = DrawUniform::texture(
                    Rect::new(ox - pad, oy - pad, used_w, used_h),
                    to_clip,
                    Rect::new(
                        0.0,
                        0.0,
                        used_w / f64::from(size.0),
                        used_h / f64::from(size.1),
                    ),
                    1.0,
                )
                .clipped(clip, clip_radius);
                draws.push((final_draw, Bind::Scratch(index)));
            }
        }
        if let Some(cursor) = &scene.cursor {
            let [r, g, b] = CLICK_FX_RGB;
            for ring in &cursor.rings {
                let reach = ring.radius + ring.stroke_width.max(1.0) * 2.0;
                let quad = Rect::new(ring.x - reach, ring.y - reach, reach * 2.0, reach * 2.0);
                let a = ring.alpha;
                draws.push((
                    DrawUniform::ring(
                        quad,
                        camera_space,
                        ring.radius,
                        ring.stroke_width,
                        [r * a, g * a, b * a, a],
                    ),
                    Bind::Plain,
                ));
            }
            for sprite in &cursor.sprites {
                let Some(glyph) = self.glyphs.get(&sprite.shape) else {
                    continue;
                };
                let gh = sprite.height;
                let gw = gh * glyph.aspect;
                // Sprite anchored at the hotspot, rotated about it.
                let local = Affine::rect(-glyph.anchor.0 * gw, -glyph.anchor.1 * gh, gw, gh);
                let quad = Affine::translate(sprite.tip_x, sprite.tip_y)
                    .then_after(Affine::rotate(sprite.rotation))
                    .then_after(local);
                draws.push((
                    DrawUniform::texture_quad(quad, (gw, gh), camera_space, sprite.alpha),
                    Bind::Glyph(sprite.shape),
                ));
            }
        }

        // Face-cam.
        if let (Some(face), Some(camera)) = (&scene.face_cam, &self.camera) {
            let face_space = stage
                .then_after(Affine::translate(face.position.0, face.position.1))
                .then_after(Affine::scale(face.scale, face.scale))
                .then_after(Affine::translate(-face.pivot.0, -face.pivot.1));
            draws.push((shadow_draw(&face.shadow, face_space), Bind::Plain));
            let spec = camera.spec;
            let uv = Rect::new(
                face.source.x / f64::from(spec.width),
                face.source.y / f64::from(spec.height),
                face.source.width / f64::from(spec.width),
                face.source.height / f64::from(spec.height),
            );
            let mut video = DrawUniform::video(
                Rect::new(0.0, 0.0, face.width, face.height),
                face_space,
                uv,
                face.radius,
                spec.color,
            );
            if face.mirrored {
                video = video.mirrored();
            }
            draws.push((video, Bind::Camera));
        }

        // Captions: boxes now, text after every quad.
        if let Some(text) = &mut self.text {
            let mut boxes = Vec::new();
            text.prepare(
                &self.ctx.device,
                &self.ctx.queue,
                captions,
                scene.captions.as_ref(),
                stage,
                &mut boxes,
            )?;
            draws.extend(boxes.into_iter().map(|d| (d, Bind::Plain)));
        }

        self.write_uniforms(&draws)?;
        let device = &self.ctx.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("frame"),
        });

        for &(index, draw_index, sigma) in &region_jobs {
            let scratch = &self.scratch[index];
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur region"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &scratch.a_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(
                    0,
                    &self.screen.bind_group,
                    &[(draw_index as u64 * DRAW_STRIDE) as u32],
                );
                pass.draw(0..6, 0..1);
            }
            self.blur.pass(
                device,
                &self.ctx.queue,
                &mut encoder,
                &scratch.a_view,
                &scratch.b_view,
                true,
                sigma,
            );
            self.blur.pass(
                device,
                &self.ctx.queue,
                &mut encoder,
                &scratch.b_view,
                &scratch.a_view,
                false,
                sigma,
            );
        }

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            let prep_draws: Vec<usize> = region_jobs.iter().map(|job| job.1).collect();
            for (i, (_, bind)) in draws.iter().enumerate() {
                if prep_draws.contains(&i) {
                    continue;
                }
                let group = match bind {
                    Bind::Plain => &self.plain,
                    Bind::Background => self.background.as_ref().unwrap_or(&self.plain),
                    Bind::Screen => &self.screen.bind_group,
                    Bind::Camera => match &self.camera {
                        Some(c) => &c.bind_group,
                        None => continue,
                    },
                    Bind::Glyph(shape) => &self.glyphs[shape].bind_group,
                    Bind::Scratch(index) => &self.scratch[*index].bind_a,
                };
                pass.set_bind_group(0, group, &[(i as u64 * DRAW_STRIDE) as u32]);
                pass.draw(0..6, 0..1);
            }
            if let Some(text) = &self.text {
                text.render(&mut pass)?;
            }
        }

        self.nv12.encode(&mut encoder, slot);
        let submission = self.ctx.queue.submit([encoder.finish()]);
        self.nv12.begin_map(slot, submission);
        self.ctx.check()
    }

    /// Wait for `slot`'s frame and copy its NV12 bytes into `out`.
    pub fn collect(&mut self, slot: usize, out: &mut Vec<u8>) -> Result<()> {
        self.nv12.finish(&self.ctx.device, slot, out)?;
        self.ctx.check()
    }

    pub fn is_pending(&self, slot: usize) -> bool {
        self.nv12.is_pending(slot)
    }

    fn write_uniforms(&mut self, draws: &[(DrawUniform, Bind)]) -> Result<()> {
        if draws.len() as u64 > self.max_draws {
            return Err(EngineError::Gpu(format!(
                "{} draws exceed the {} planned for this job",
                draws.len(),
                self.max_draws
            )));
        }
        self.staging.clear();
        for (draw, _) in draws {
            self.staging.extend_from_slice(bytemuck::bytes_of(draw));
        }
        if !self.staging.is_empty() {
            self.ctx
                .queue
                .write_buffer(&self.uniforms, 0, &self.staging);
        }
        Ok(())
    }

    /// A scratch pair at least `w`×`h` for blur region `index`.
    fn ensure_scratch(&mut self, index: usize, w: u32, h: u32) -> (u32, u32) {
        let fits = self
            .scratch
            .get(index)
            .is_some_and(|s| s.size.0 >= w && s.size.1 >= h);
        if !fits {
            let size = (
                w.div_ceil(SCRATCH_STEP) * SCRATCH_STEP,
                h.div_ceil(SCRATCH_STEP) * SCRATCH_STEP,
            );
            let device = &self.ctx.device;
            let make = |label| {
                Self::texture(
                    device,
                    label,
                    size.0,
                    size.1,
                    1,
                    TARGET_FORMAT,
                    wgpu::TextureUsages::RENDER_ATTACHMENT,
                )
                .create_view(&Default::default())
            };
            let a_view = make("blur scratch a");
            let b_view = make("blur scratch b");
            let bind_a = Self::bind_group(
                device,
                &self.layout,
                &self.uniforms,
                &self.sampler,
                &a_view,
                &self.dummy_y,
                &self.dummy_uv,
            );
            let scratch = Scratch {
                size,
                a_view,
                b_view,
                bind_a,
            };
            if index < self.scratch.len() {
                self.scratch[index] = scratch;
            } else {
                // Regions are filled in order, so `index` is always the next slot.
                self.scratch.push(scratch);
            }
        }
        self.scratch[index].size
    }
}

/// Analytic shadow behind `shadow.rect`, on a quad covering its reach.
fn shadow_draw(shadow: &ShadowDraw, space: Affine) -> DrawUniform {
    let reach = shadow.reach();
    let quad = Rect::new(
        shadow.rect.x - reach,
        shadow.rect.y - reach,
        shadow.rect.width + reach * 2.0,
        shadow.rect.height + reach * 2.0,
    );
    DrawUniform::shadow(quad, space, shadow.rect, shadow.radius, &shadow.passes)
}

/// Map an axis-aligned rect through a scale+translate affine.
fn transform_rect(affine: Affine, rect: Rect) -> Rect {
    let (x0, y0) = affine.apply(rect.x, rect.y);
    let (x1, y1) = affine.apply(rect.x + rect.width, rect.y + rect.height);
    Rect::new(x0.min(x1), y0.min(y1), (x1 - x0).abs(), (y1 - y0).abs())
}
