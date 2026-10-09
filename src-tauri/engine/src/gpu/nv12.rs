//! Composite → NV12 on the GPU, read back through a ring of mapped buffers.
//!
//! Converting before readback moves 1.5 bytes per pixel instead of 4 (3.1 MB
//! instead of 8.3 MB at 1080p), and the ring keeps the GPU a few frames ahead
//! of the CPU: frame N converts while frame N−2 is copied out to the encoder.

use std::sync::mpsc;

use bytemuck::{Pod, Zeroable};

use crate::error::{EngineError, Result};

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
struct Params {
    width: u32,
    height: u32,
    _pad: [u32; 2],
}

struct Slot {
    buffer: wgpu::Buffer,
    /// Set once the slot holds a submitted frame whose map is pending.
    pending: Option<(
        wgpu::SubmissionIndex,
        mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>,
    )>,
}

pub struct Nv12Readback {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    storage: wgpu::Buffer,
    slots: Vec<Slot>,
    width: u32,
    height: u32,
    len: u64,
}

impl Nv12Readback {
    /// `width` must be a multiple of 4 and `height` even.
    pub fn new(
        device: &wgpu::Device,
        source: &wgpu::TextureView,
        width: u32,
        height: u32,
        slots: usize,
    ) -> Result<Self> {
        if !width.is_multiple_of(4) || !height.is_multiple_of(2) {
            return Err(EngineError::Encode(format!(
                "output {width}x{height}: NV12 export needs a width divisible by 4 and an even height"
            )));
        }
        let len = u64::from(width) * u64::from(height) * 3 / 2;
        let shader = device.create_shader_module(wgpu::include_wgsl!("shaders/nv12.wgsl"));
        let storage = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("nv12"),
            size: len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let params = wgpu::util::DeviceExt::create_buffer_init(
            device,
            &wgpu::util::BufferInitDescriptor {
                label: Some("nv12 params"),
                contents: bytemuck::bytes_of(&Params {
                    width,
                    height,
                    _pad: [0; 2],
                }),
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("nv12"),
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("nv12"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: storage.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        let slots = (0..slots.max(1))
            .map(|i| Slot {
                buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("nv12 readback {i}")),
                    size: len,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                pending: None,
            })
            .collect();
        Ok(Self {
            pipeline,
            bind_group,
            storage,
            slots,
            width,
            height,
            len,
        })
    }

    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    pub fn frame_len(&self) -> usize {
        self.len as usize
    }

    pub fn is_pending(&self, slot: usize) -> bool {
        self.slots[slot].pending.is_some()
    }

    /// Record conversion + copy into `slot`'s readback buffer.
    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder, slot: usize) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("nv12"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            let blocks_x = self.width / 4;
            let blocks_y = self.height / 2;
            pass.dispatch_workgroups(blocks_x.div_ceil(16), blocks_y.div_ceil(8), 1);
        }
        encoder.copy_buffer_to_buffer(&self.storage, 0, &self.slots[slot].buffer, 0, self.len);
    }

    /// After `submission` has been submitted: start mapping `slot`.
    pub fn begin_map(&mut self, slot: usize, submission: wgpu::SubmissionIndex) {
        let (tx, rx) = mpsc::channel();
        self.slots[slot]
            .buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
        self.slots[slot].pending = Some((submission, rx));
    }

    /// Wait for `slot`'s frame, copy it into `out` and release the slot.
    pub fn finish(&mut self, device: &wgpu::Device, slot: usize, out: &mut Vec<u8>) -> Result<()> {
        let (submission, rx) = self.slots[slot]
            .pending
            .take()
            .ok_or_else(|| EngineError::Gpu("readback slot has no frame".into()))?;
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: None,
            })
            .map_err(|e| EngineError::Gpu(format!("waiting for frame: {e}")))?;
        rx.recv()
            .map_err(|_| EngineError::Gpu("readback callback dropped".into()))?
            .map_err(|e| EngineError::Gpu(format!("mapping frame: {e}")))?;
        let buffer = &self.slots[slot].buffer;
        {
            let view = buffer
                .slice(..)
                .get_mapped_range()
                .map_err(|e| EngineError::Gpu(format!("reading frame: {e}")))?;
            out.clear();
            out.extend_from_slice(&view);
        }
        buffer.unmap();
        Ok(())
    }
}
