//! GPU compositor (wgpu: Metal, DX12, Vulkan, or GL).

pub mod blur;
pub mod compositor;
pub mod draw;
pub mod nv12;
pub mod text;

pub use compositor::Compositor;

use std::sync::{Arc, Mutex};

use crate::error::{EngineError, Result};

/// The device every GPU stage shares.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
    /// First validation/out-of-memory error since the last [`Self::check`].
    /// wgpu's default handler panics, which would take the app down with an
    /// export; errors surface as `Err` instead.
    errors: Arc<Mutex<Option<String>>>,
}

impl GpuContext {
    /// Pick the high-performance adapter, falling back to any adapter
    /// (including a software one) rather than failing an export outright.
    pub fn new() -> Result<Self> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            ..Default::default()
        }))
        .or_else(|_| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: true,
                compatible_surface: None,
                ..Default::default()
            }))
        })
        .map_err(|e| EngineError::Gpu(format!("no graphics adapter: {e}")))?;
        let adapter_info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("capptivo-engine"),
            required_features: wgpu::Features::empty(),
            // Downlevel defaults keep GL/older GPUs working; raise only the
            // texture size so 4K sources and outputs fit.
            required_limits: wgpu::Limits {
                max_texture_dimension_2d: adapter.limits().max_texture_dimension_2d.min(8192),
                ..wgpu::Limits::downlevel_defaults()
            },
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|e| EngineError::Gpu(format!("could not open {}: {e}", adapter_info.name)))?;
        let errors = Arc::new(Mutex::new(None));
        let sink = errors.clone();
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            let mut slot = sink.lock().unwrap_or_else(|p| p.into_inner());
            if slot.is_none() {
                *slot = Some(error.to_string());
            }
        }));
        Ok(Self {
            device,
            queue,
            adapter_info,
            errors,
        })
    }

    /// Fail with the first GPU error raised since the last check.
    pub fn check(&self) -> Result<()> {
        let error = self.errors.lock().unwrap_or_else(|p| p.into_inner()).take();
        match error {
            Some(message) => Err(EngineError::Gpu(message)),
            None => Ok(()),
        }
    }

    /// Short description for logs: "Apple M5 (Metal)".
    pub fn describe(&self) -> String {
        format!(
            "{} ({:?})",
            self.adapter_info.name, self.adapter_info.backend
        )
    }
}

/// A 2D affine map `p ↦ M·p + t`, column-major like WGSL.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    /// `[m00, m10, m01, m11]`: x' = m00·x + m01·y + tx, y' = m10·x + m11·y + ty.
    pub m: [f64; 4],
    pub t: [f64; 2],
}

impl Affine {
    pub const IDENTITY: Affine = Affine {
        m: [1.0, 0.0, 0.0, 1.0],
        t: [0.0, 0.0],
    };

    pub fn translate(x: f64, y: f64) -> Self {
        Self {
            t: [x, y],
            ..Self::IDENTITY
        }
    }

    pub fn scale(sx: f64, sy: f64) -> Self {
        Self {
            m: [sx, 0.0, 0.0, sy],
            t: [0.0, 0.0],
        }
    }

    pub fn rotate(radians: f64) -> Self {
        let (s, c) = radians.sin_cos();
        Self {
            m: [c, s, -s, c],
            t: [0.0, 0.0],
        }
    }

    /// `self ∘ inner`: apply `inner` first.
    pub fn then_after(self, inner: Affine) -> Affine {
        let a = self.m;
        let b = inner.m;
        Affine {
            m: [
                a[0] * b[0] + a[2] * b[1],
                a[1] * b[0] + a[3] * b[1],
                a[0] * b[2] + a[2] * b[3],
                a[1] * b[2] + a[3] * b[3],
            ],
            t: [
                a[0] * inner.t[0] + a[2] * inner.t[1] + self.t[0],
                a[1] * inner.t[0] + a[3] * inner.t[1] + self.t[1],
            ],
        }
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.m[0] * x + self.m[2] * y + self.t[0],
            self.m[1] * x + self.m[3] * y + self.t[1],
        )
    }

    /// Unit quad → the axis-aligned rect `(x, y, w, h)`.
    pub fn rect(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self {
            m: [w, 0.0, 0.0, h],
            t: [x, y],
        }
    }

    /// Pixel space of a `width`×`height` target → clip space.
    pub fn pixels_to_clip(width: f64, height: f64) -> Self {
        Self {
            m: [2.0 / width, 0.0, 0.0, -2.0 / height],
            t: [-1.0, 1.0],
        }
    }

    fn columns(&self) -> ([f32; 4], [f32; 4]) {
        (
            [
                self.m[0] as f32,
                self.m[1] as f32,
                self.m[2] as f32,
                self.m[3] as f32,
            ],
            [self.t[0] as f32, self.t[1] as f32, 0.0, 0.0],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composition_applies_inner_first() {
        let outer = Affine::translate(10.0, 0.0);
        let inner = Affine::scale(2.0, 3.0);
        assert_eq!(outer.then_after(inner).apply(1.0, 1.0), (12.0, 3.0));
        assert_eq!(inner.then_after(outer).apply(1.0, 1.0), (22.0, 3.0));
    }

    #[test]
    fn pixels_map_to_clip_corners() {
        let clip = Affine::pixels_to_clip(1920.0, 1080.0);
        assert_eq!(clip.apply(0.0, 0.0), (-1.0, 1.0));
        assert_eq!(clip.apply(1920.0, 1080.0), (1.0, -1.0));
    }
}
