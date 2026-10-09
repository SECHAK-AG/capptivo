//! Streaming NV12 decode through the FFmpeg sidecar.
//!
//! One FFmpeg child decodes forward and writes tightly packed NV12 to a pipe.
//! Frames are identified by position: the n-th frame out of the pipe is
//! `MediaInfo::frame_times[start + n]` (see `probe.rs`). Moving backwards, or
//! skipping far ahead past a keyframe (a trim), restarts the child at the
//! keyframe so trimmed-away footage is never decoded.
//!
//! Software decode on purpose: on Apple Silicon it measured 532 fps for a
//! 3024×1964 screen recording against 251 fps for VideoToolbox + download,
//! and it behaves identically on every platform.

use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use crossbeam_channel::{bounded, Receiver, Sender};

use crate::error::{EngineError, Result};
use crate::media::probe::{ColorInfo, MediaInfo};
use crate::media::process::{command, kill, StderrTail};

/// Skip at most this many frames by decoding through them; beyond, seek.
const SEEK_THRESHOLD_FRAMES: usize = 120;

/// One decoded frame.
#[derive(Debug)]
pub struct Nv12Frame {
    /// Index into `MediaInfo::frame_times`.
    pub index: usize,
    /// `width × height` luma then `width × height / 2` interleaved chroma.
    pub data: Vec<u8>,
}

struct DecodeProcess {
    child: Child,
    stdout: ChildStdout,
    stderr: StderrTail,
}

impl Drop for DecodeProcess {
    fn drop(&mut self) {
        kill(&mut self.child);
    }
}

/// Random-access-by-index reader over one file, optimized for forward reads.
pub struct FrameDecoder {
    ffmpeg: PathBuf,
    path: PathBuf,
    info: Arc<MediaInfo>,
    process: Option<DecodeProcess>,
    /// The frame the pipe yields next.
    next_index: usize,
    scratch: Vec<u8>,
}

impl FrameDecoder {
    pub fn new(ffmpeg: &Path, path: &Path, info: Arc<MediaInfo>) -> Self {
        Self {
            ffmpeg: ffmpeg.to_path_buf(),
            path: path.to_path_buf(),
            info,
            process: None,
            next_index: 0,
            scratch: Vec::new(),
        }
    }

    pub fn info(&self) -> &MediaInfo {
        &self.info
    }

    /// Colour of the frames this decoder emits. Full-range sources are
    /// converted to limited range by FFmpeg, so the shader sees one range.
    pub fn output_color(&self) -> ColorInfo {
        ColorInfo {
            full_range: false,
            ..self.info.color
        }
    }

    /// Read frame `index` into `buf`. `Ok(false)` means the stream ended
    /// before that frame (the file has fewer decodable frames than packets).
    pub fn read(&mut self, index: usize, buf: &mut [u8]) -> Result<bool> {
        let frame_len = self.info.nv12_frame_len();
        if buf.len() != frame_len {
            return Err(EngineError::media(
                &self.path,
                format!("frame buffer is {} bytes, want {frame_len}", buf.len()),
            ));
        }
        let index = index.min(self.info.frame_times.len() - 1);
        let restart = match self.process {
            None => true,
            Some(_) => index < self.next_index || self.worth_seeking(index),
        };
        if restart {
            self.start_at(self.info.keyframe_at_or_before(index))?;
        }
        self.scratch.resize(frame_len, 0);
        while self.next_index < index {
            if !self.read_next(None)? {
                return Ok(false);
            }
        }
        self.read_next(Some(buf))
    }

    fn worth_seeking(&self, index: usize) -> bool {
        self.info.keyframe_at_or_before(index) > self.next_index
            && index - self.next_index > SEEK_THRESHOLD_FRAMES
    }

    fn read_next(&mut self, into: Option<&mut [u8]>) -> Result<bool> {
        let process = self
            .process
            .as_mut()
            .ok_or_else(|| EngineError::media(&self.path, "decoder is not running"))?;
        let target = match into {
            Some(buf) => buf,
            None => &mut self.scratch[..],
        };
        match process.stdout.read_exact(target) {
            Ok(()) => {
                self.next_index += 1;
                Ok(true)
            }
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                // Distinguish "file had fewer frames" from "ffmpeg failed".
                let mut process = self.process.take().expect("checked above");
                let status = process.child.wait().ok();
                let stderr = process.stderr.finish();
                match status {
                    Some(s) if s.success() => Ok(false),
                    _ => Err(EngineError::media(
                        &self.path,
                        format!("decoder failed: {stderr}"),
                    )),
                }
            }
            Err(e) => Err(EngineError::media(
                &self.path,
                format!("reading decoded frames: {e}"),
            )),
        }
    }

    /// (Re)start decoding so the pipe's first frame is `keyframe`.
    fn start_at(&mut self, keyframe: usize) -> Result<()> {
        self.process = None;
        let mut cmd = command(&self.ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        if keyframe > 0 {
            // Input seeking decodes from the keyframe at or before `-ss` and
            // drops everything earlier. Land just before the keyframe's own
            // timestamp so rounding can never drop the frame we want.
            let times = &self.info.frame_times;
            let guard = (0.4 * (times[keyframe] - times[keyframe - 1])).min(0.001);
            let position = times[keyframe] - self.info.start_time - guard;
            cmd.args(["-ss", &format!("{position:.6}")]);
        }
        cmd.arg("-i").arg(&self.path);
        cmd.args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-fps_mode",
            "passthrough",
        ]);
        if self.info.color.full_range {
            cmd.args(["-vf", "scale=out_range=tv"]);
        }
        cmd.args(["-pix_fmt", "nv12", "-f", "rawvideo", "pipe:1"]);
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                EngineError::Process(format!("could not start {}: {e}", self.ffmpeg.display()))
            })?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = StderrTail::spawn(child.stderr.take().expect("piped stderr"), "decode");
        self.process = Some(DecodeProcess {
            child,
            stdout,
            stderr,
        });
        self.next_index = keyframe;
        Ok(())
    }
}

/// Decoded frames in the order a job asked for them, with recycled buffers.
pub struct DecodeStream {
    pub frames: Receiver<Result<Nv12Frame>>,
    pub recycle: Sender<Vec<u8>>,
    thread: Option<JoinHandle<()>>,
}

impl DecodeStream {
    /// Decode `plan` (frame indices, consecutive duplicates already removed)
    /// on a background thread, holding at most `depth` frames in flight.
    pub fn spawn(
        mut decoder: FrameDecoder,
        plan: Vec<usize>,
        depth: usize,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        let depth = depth.max(1);
        let (frames_tx, frames_rx) = bounded::<Result<Nv12Frame>>(depth);
        let (recycle_tx, recycle_rx) = bounded::<Vec<u8>>(depth + 2);
        let frame_len = decoder.info().nv12_frame_len();
        for _ in 0..depth + 1 {
            let _ = recycle_tx.send(vec![0u8; frame_len]);
        }
        let thread = std::thread::Builder::new()
            .name("engine-decode".into())
            .spawn(move || {
                let mut last_good: Option<Vec<u8>> = None;
                let mut warned = false;
                for index in plan {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(mut buf) = recycle_rx.recv() else {
                        return;
                    };
                    let result = match decoder.read(index, &mut buf) {
                        Ok(true) => {
                            last_good.get_or_insert_with(Vec::new).clone_from(&buf);
                            Ok(Nv12Frame { index, data: buf })
                        }
                        Ok(false) => match &last_good {
                            // Fewer frames than packets: hold the last one.
                            Some(last) => {
                                if !warned {
                                    tracing::warn!(
                                        index,
                                        "decode ended early; holding the last frame"
                                    );
                                    warned = true;
                                }
                                buf.copy_from_slice(last);
                                Ok(Nv12Frame { index, data: buf })
                            }
                            None => Err(EngineError::media(&decoder.path, "no decodable frames")),
                        },
                        Err(e) => Err(e),
                    };
                    let failed = result.is_err();
                    if frames_tx.send(result).is_err() || failed {
                        return;
                    }
                }
            })
            .expect("spawn decode thread");
        Self {
            frames: frames_rx,
            recycle: recycle_tx,
            thread: Some(thread),
        }
    }
}

impl Drop for DecodeStream {
    fn drop(&mut self) {
        // Close both channels so a worker blocked on either one returns.
        let (_, dead_frames) = bounded::<Result<Nv12Frame>>(0);
        let (dead_recycle, _) = bounded::<Vec<u8>>(0);
        drop(std::mem::replace(&mut self.frames, dead_frames));
        drop(std::mem::replace(&mut self.recycle, dead_recycle));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Collapse a per-output-frame index list into the decode order.
pub fn dedup_plan(per_frame: &[usize]) -> Vec<usize> {
    let mut plan: Vec<usize> = Vec::with_capacity(per_frame.len());
    for &index in per_frame {
        if plan.last() != Some(&index) {
            plan.push(index);
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_keeps_order_and_revisits() {
        assert_eq!(dedup_plan(&[0, 0, 1, 1, 1, 3, 3, 1, 1]), vec![0, 1, 3, 1]);
    }
}
