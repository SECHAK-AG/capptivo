//! One export job: decode ‖ composite ‖ encode, on three threads.
//!
//! ```text
//! decode thread(s) ──NV12──▶ render (this thread): upload, scene, GPU, NV12 readback
//!                                        │ (ring of in-flight frames)
//!                                        ▼
//!                               encoder thread ──▶ ffmpeg stdin
//! ```
//!
//! Every output frame's source frames are planned up front from the same
//! frame clock the editor uses, so no stage can drift from another.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};

use crate::assets::CursorGlyphs;
use crate::document::{CursorShape, RenderDocument};
use crate::encode::{Encoder, EncoderSpec, OutputSpec};
use crate::error::{EngineError, Result};
use crate::gpu::compositor::{CompositorConfig, VideoSpec};
use crate::gpu::{Compositor, GpuContext};
use crate::layout::composition_size_for_output;
use crate::media::decode::{dedup_plan, DecodeStream};
use crate::media::{probe, FrameDecoder, MediaInfo, Nv12Frame};
use crate::scene::{GlyphAspect, MediaSizes, SceneBuilder};
use crate::timeline::face_cam::face_cam_frame_at;
use crate::timeline::segments::plan_frame_times;

/// Frames kept in flight between the GPU and the encoder.
const READBACK_SLOTS: usize = 3;
/// Decoded frames buffered ahead of the compositor, per track.
const DECODE_DEPTH: usize = 4;
/// Encoded-frame queue between render and encoder threads.
const ENCODE_DEPTH: usize = 4;

/// Everything one export needs.
#[derive(Debug, Clone)]
pub struct ExportRequest {
    pub document: RenderDocument,
    pub screen: PathBuf,
    pub camera: Option<PathBuf>,
    /// Encoded background image, when one is selected.
    pub background: Option<Vec<u8>>,
    pub ffprobe: PathBuf,
    pub encoder: EncoderSpec,
    pub output: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Prepared audio to mux in.
    pub audio: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
pub struct Progress {
    pub frames_done: u64,
    pub frames_total: u64,
}

/// What the job did and where the time went.
#[derive(Debug, Clone)]
pub struct ExportStats {
    pub frames: u64,
    pub wall: Duration,
    pub setup: Duration,
    pub decode_wait: Duration,
    pub render: Duration,
    pub readback_wait: Duration,
    pub encode_wait: Duration,
    pub gpu: String,
}

impl ExportStats {
    pub fn fps(&self) -> f64 {
        self.frames as f64 / self.wall.as_secs_f64().max(1e-9)
    }
}

impl std::fmt::Display for ExportStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let per = |d: Duration| ms(d) / self.frames.max(1) as f64;
        write!(
            f,
            "{} frames in {:.2}s ({:.1} fps) on {} — setup {:.0} ms; per frame: decode wait {:.2} ms, \
             render {:.2} ms, readback wait {:.2} ms, encode wait {:.2} ms",
            self.frames,
            self.wall.as_secs_f64(),
            self.fps(),
            self.gpu,
            ms(self.setup),
            per(self.decode_wait),
            per(self.render),
            per(self.readback_wait),
            per(self.encode_wait),
        )
    }
}

/// A decoded track and which of its frames each output frame shows.
struct Track {
    /// Per output frame; `None` where the track isn't drawn.
    per_frame: Vec<Option<usize>>,
    stream: DecodeStream,
    current: Option<usize>,
}

impl Track {
    fn open(
        ffmpeg: &std::path::Path,
        path: &std::path::Path,
        info: Arc<MediaInfo>,
        per_frame: Vec<Option<usize>>,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        let plan = dedup_plan(&per_frame.iter().flatten().copied().collect::<Vec<_>>());
        let decoder = FrameDecoder::new(ffmpeg, path, info.clone());
        Self {
            per_frame,
            stream: DecodeStream::spawn(decoder, plan, DECODE_DEPTH, cancel),
            current: None,
        }
    }

    /// The decoded frame output frame `i` needs, if it differs from the one
    /// already uploaded.
    fn next_for(&mut self, i: usize) -> Result<Option<Nv12Frame>> {
        let Some(wanted) = self.per_frame[i] else {
            return Ok(None);
        };
        if self.current == Some(wanted) {
            return Ok(None);
        }
        let frame = self
            .stream
            .frames
            .recv()
            .map_err(|_| EngineError::Process("decoder stopped".into()))??;
        if frame.index != wanted {
            return Err(EngineError::Process(format!(
                "decoder out of step: got frame {}, wanted {wanted}",
                frame.index
            )));
        }
        self.current = Some(wanted);
        Ok(Some(frame))
    }

    fn recycle(&self, frame: Nv12Frame) {
        let _ = self.stream.recycle.try_send(frame.data);
    }
}

struct Glyphs(Option<Arc<CursorGlyphs>>);

impl GlyphAspect for Glyphs {
    fn aspect(&self, shape: CursorShape) -> f64 {
        self.0.as_ref().map_or(1.0, |g| g.aspect(shape))
    }
}

/// Render the document to `request.output`. `progress` is called every few
/// frames; set `cancel` to stop (the partial file is removed).
pub fn export(
    request: &ExportRequest,
    progress: impl FnMut(Progress),
    cancel: Arc<AtomicBool>,
) -> Result<ExportStats> {
    if request.fps == 0 {
        return Err(EngineError::Document("fps must be positive".into()));
    }
    let times = plan_frame_times(&request.document.kept_segments(), f64::from(request.fps));
    if times.is_empty() {
        return Err(EngineError::Document(
            "nothing to export: every frame is trimmed".into(),
        ));
    }
    let encoder = Encoder::spawn(
        &request.encoder,
        &OutputSpec {
            path: request.output.clone(),
            width: request.width,
            height: request.height,
            fps: request.fps,
            frames: times.len() as u64,
            audio: request.audio.clone(),
        },
    )?;
    let frame_len = crate::media::probe::nv12_len(request.width, request.height);
    let abort = Arc::new(AtomicBool::new(false));
    let stage = spawn_encoder(encoder, frame_len, abort.clone());
    let rendered = run_frames(request, &times, stage.input, &stage.free, progress, cancel);
    if rendered.is_err() {
        abort.store(true, Ordering::Relaxed);
    }
    let encoded = stage
        .thread
        .join()
        .map_err(|_| EngineError::Encode("encoder thread panicked".into()))?;
    match (rendered, encoded) {
        (Ok(stats), Ok(())) => {
            tracing::info!(target: "capptivo_engine", "export: {stats}");
            Ok(stats)
        }
        (Err(e), _) | (Ok(_), Err(e)) => {
            let _ = std::fs::remove_file(&request.output);
            Err(e)
        }
    }
}

/// Render single frames at source times `times` (seconds) as NV12, for
/// inspection and tests. No encoder, no audio.
pub fn render_stills(request: &ExportRequest, times: &[f64]) -> Result<Vec<Vec<u8>>> {
    let frame_len = crate::media::probe::nv12_len(request.width, request.height);
    let (sink, frames) = bounded::<Vec<u8>>(times.len().max(1));
    let (free_tx, free) = bounded::<Vec<u8>>(times.len() + READBACK_SLOTS);
    for _ in 0..times.len() + READBACK_SLOTS {
        let _ = free_tx.send(Vec::with_capacity(frame_len));
    }
    run_frames(
        request,
        times,
        sink,
        &free,
        |_| {},
        Arc::new(AtomicBool::new(false)),
    )?;
    Ok(frames.try_iter().collect())
}

/// Decode, composite and convert every frame of `times`, handing NV12
/// buffers to `sink` in order.
fn run_frames(
    request: &ExportRequest,
    times: &[f64],
    sink: Sender<Vec<u8>>,
    free_frames: &Receiver<Vec<u8>>,
    mut progress: impl FnMut(Progress),
    cancel: Arc<AtomicBool>,
) -> Result<ExportStats> {
    let started = Instant::now();
    let doc = &request.document;

    let screen_info = Arc::new(probe(&request.ffprobe, &request.screen)?);
    let camera_info = match &request.camera {
        Some(path) if path.is_file() => Some(Arc::new(probe(&request.ffprobe, path)?)),
        _ => None,
    };

    let total = times.len() as u64;

    let composition = composition_size_for_output(request.width, request.height);
    let media = MediaSizes {
        screen_width: f64::from(screen_info.width),
        screen_height: f64::from(screen_info.height),
        camera: camera_info
            .as_ref()
            .map(|c| (f64::from(c.width), f64::from(c.height), c.duration)),
    };
    let builder = SceneBuilder::new(
        doc.clone(),
        request.background.is_some(),
        composition.width,
        composition.height,
        media,
    );

    let glyphs = if doc.cursor_settings.show_cursor && doc.recording_metadata.is_some() {
        Some(Arc::new(CursorGlyphs::load(doc.cursor_settings.style)?))
    } else {
        None
    };

    let ctx = Arc::new(GpuContext::new()?);
    let gpu = ctx.describe();
    let mut compositor = Compositor::new(
        ctx,
        CompositorConfig {
            output_width: request.width,
            output_height: request.height,
            composition,
            screen: VideoSpec {
                width: screen_info.width,
                height: screen_info.height,
                color: crate::media::ColorInfo {
                    full_range: false,
                    ..screen_info.color
                },
            },
            camera: camera_info.as_ref().map(|c| VideoSpec {
                width: c.width,
                height: c.height,
                color: crate::media::ColorInfo {
                    full_range: false,
                    ..c.color
                },
            }),
            background: request.background.as_deref(),
            background_blur: doc.look.background_blur,
            glyphs: glyphs.as_deref(),
            captions: Some(&doc.caption_settings),
            blur_regions: doc.blur_regions.len(),
            readback_slots: READBACK_SLOTS,
        },
    )?;
    let glyph_aspect = Glyphs(glyphs);

    // Source frame per output frame, from the editor's frame clock.
    let screen_per_frame: Vec<Option<usize>> = times
        .iter()
        .map(|&t| Some(screen_info.frame_index_at(t)))
        .collect();
    let mut screen = Track::open(
        &request.encoder.ffmpeg,
        &request.screen,
        screen_info.clone(),
        screen_per_frame,
        cancel.clone(),
    );
    let mut camera = match (&request.camera, &camera_info) {
        (Some(path), Some(info)) => {
            let per_frame = times
                .iter()
                .map(|&t| {
                    face_cam_frame_at(t, doc.camera_offset_ms, info.duration)
                        .media_time()
                        .map(|mt| info.frame_index_at(mt))
                })
                .collect();
            Some(Track::open(
                &request.encoder.ffmpeg,
                path,
                info.clone(),
                per_frame,
                cancel.clone(),
            ))
        }
        _ => None,
    };

    let setup = started.elapsed();

    let mut stats = ExportStats {
        frames: total,
        wall: Duration::ZERO,
        setup,
        decode_wait: Duration::ZERO,
        render: Duration::ZERO,
        readback_wait: Duration::ZERO,
        encode_wait: Duration::ZERO,
        gpu,
    };

    let result = (|| -> Result<()> {
        let slots = compositor.readback_slots();
        let ship =
            |compositor: &mut Compositor, slot: usize, stats: &mut ExportStats| -> Result<()> {
                let t0 = Instant::now();
                let mut buf = free_frames.recv().unwrap_or_default();
                compositor.collect(slot, &mut buf)?;
                let t1 = Instant::now();
                stats.readback_wait += t1 - t0;
                sink.send(buf)
                    .map_err(|_| EngineError::Encode("encoder stopped".into()))?;
                stats.encode_wait += t1.elapsed();
                Ok(())
            };

        for (i, &t) in times.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(EngineError::Cancelled);
            }
            let t0 = Instant::now();
            let screen_frame = screen.next_for(i)?;
            let camera_frame = match camera.as_mut() {
                Some(track) => track.next_for(i)?,
                None => None,
            };
            stats.decode_wait += t0.elapsed();

            let slot = i % slots;
            if compositor.is_pending(slot) {
                ship(&mut compositor, slot, &mut stats)?;
            }

            let t1 = Instant::now();
            if let Some(frame) = screen_frame {
                compositor.upload_screen(&frame.data)?;
                screen.recycle(frame);
            }
            if let (Some(frame), Some(track)) = (camera_frame, camera.as_ref()) {
                compositor.upload_camera(&frame.data)?;
                track.recycle(frame);
            }
            let scene = builder.frame(t, &glyph_aspect);
            compositor.render(&scene, builder.captions(), slot)?;
            stats.render += t1.elapsed();

            if i % 10 == 0 {
                progress(Progress {
                    frames_done: i as u64,
                    frames_total: total,
                });
            }
        }
        // Drain the ring in frame order.
        let n = times.len();
        for i in n.saturating_sub(slots)..n {
            let slot = i % slots;
            if compositor.is_pending(slot) {
                ship(&mut compositor, slot, &mut stats)?;
            }
        }
        Ok(())
    })();

    drop(sink);
    drop(screen);
    drop(camera);
    result?;
    progress(Progress {
        frames_done: total,
        frames_total: total,
    });
    stats.wall = started.elapsed();
    Ok(stats)
}

/// The encoder thread and its two queues.
struct EncoderStage {
    /// Frames to encode, in order; dropping it ends the stream.
    input: Sender<Vec<u8>>,
    /// Buffers handed back once written, for the next frames.
    free: Receiver<Vec<u8>>,
    thread: std::thread::JoinHandle<Result<()>>,
}

/// Writes frames to FFmpeg on its own thread. When `abort` is set by the time
/// the input closes, FFmpeg is killed and the partial file removed instead of
/// finalized.
fn spawn_encoder(encoder: Encoder, frame_len: usize, abort: Arc<AtomicBool>) -> EncoderStage {
    let (input, frames) = bounded::<Vec<u8>>(ENCODE_DEPTH);
    let (free_tx, free) = bounded::<Vec<u8>>(ENCODE_DEPTH + READBACK_SLOTS + 1);
    for _ in 0..ENCODE_DEPTH + READBACK_SLOTS {
        let _ = free_tx.send(Vec::with_capacity(frame_len));
    }
    let thread = std::thread::Builder::new()
        .name("engine-encode".into())
        .spawn(move || {
            let mut encoder = encoder;
            for frame in frames {
                if let Err(e) = encoder.write_frame(&frame) {
                    encoder.abort();
                    return Err(e);
                }
                let _ = free_tx.try_send(frame);
            }
            if abort.load(Ordering::Relaxed) {
                encoder.abort();
                return Err(EngineError::Cancelled);
            }
            encoder.finish().map(|_| ())
        })
        .expect("spawn encoder thread");
    EncoderStage {
        input,
        free,
        thread,
    }
}
