//! NV12 frames → hardware H.264 MP4 (with audio) through the FFmpeg sidecar.
//!
//! The encoder choice (VideoToolbox / NVENC / QSV / AMF / VAAPI / x264) is the
//! caller's: the app probes the machine once (`recorder/hw_encoder.rs`) and
//! hands the codec arguments in. Audio, already trimmed and enhanced, is muxed
//! in the same pass — no second remux of the finished file.

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};

use crate::error::{EngineError, Result};
use crate::media::process::{command, kill, StderrTail};

/// How to encode, as decided by the caller.
#[derive(Debug, Clone)]
pub struct EncoderSpec {
    pub ffmpeg: PathBuf,
    /// Global/input-side arguments (e.g. a VAAPI device), before `-i`.
    pub pre_input_args: Vec<String>,
    /// Video codec arguments, e.g. `["-c:v", "h264_videotoolbox", "-b:v", "12000000"]`.
    pub video_args: Vec<String>,
}

/// What to write.
#[derive(Debug, Clone)]
pub struct OutputSpec {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: u64,
    /// Prepared audio (AAC in MP4/M4A) to stream-copy in.
    pub audio: Option<PathBuf>,
}

pub struct Encoder {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stderr: StderrTail,
    frame_len: usize,
    path: PathBuf,
}

impl Encoder {
    pub fn spawn(spec: &EncoderSpec, output: &OutputSpec) -> Result<Self> {
        let size = format!("{}x{}", output.width, output.height);
        let fps = output.fps.max(1).to_string();
        let duration = format!("{:.6}", output.frames as f64 / f64::from(output.fps.max(1)));
        let mut cmd = command(&spec.ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args(&spec.pre_input_args)
            // The composite is BT.709 limited range (see shaders/nv12.wgsl).
            .args([
                "-f",
                "rawvideo",
                "-pix_fmt",
                "nv12",
                "-color_range",
                "tv",
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-s",
                &size,
                "-framerate",
                &fps,
                "-i",
                "pipe:0",
            ]);
        if let Some(audio) = &output.audio {
            cmd.arg("-i").arg(audio);
        }
        cmd.args(["-map", "0:v:0"]);
        if output.audio.is_some() {
            cmd.args(["-map", "1:a:0", "-c:a", "copy"]);
        }
        cmd.args(&spec.video_args)
            .args([
                "-color_range",
                "tv",
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                // Every frame stays; audio past the last frame is cut.
                "-t",
                &duration,
                "-movflags",
                "+faststart+write_colr",
                "-f",
                "mp4",
            ])
            .arg(&output.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            EngineError::Encode(format!("could not start {}: {e}", spec.ffmpeg.display()))
        })?;
        let frame_len = crate::media::probe::nv12_len(output.width, output.height);
        let stdin = child.stdin.take().expect("piped stdin");
        let stderr = StderrTail::spawn(child.stderr.take().expect("piped stderr"), "encode");
        Ok(Self {
            child,
            stdin: Some(BufWriter::with_capacity(frame_len, stdin)),
            stderr,
            frame_len,
            path: output.path.clone(),
        })
    }

    pub fn write_frame(&mut self, nv12: &[u8]) -> Result<()> {
        if nv12.len() != self.frame_len {
            return Err(EngineError::Encode(format!(
                "frame is {} bytes, want {}",
                nv12.len(),
                self.frame_len
            )));
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| EngineError::Encode("encoder already finished".into()))?;
        if let Err(e) = stdin.write_all(nv12) {
            // A broken pipe means FFmpeg exited; its stderr says why.
            let _ = self.child.wait();
            return Err(EngineError::Encode(format!(
                "{e}: {}",
                self.stderr.finish()
            )));
        }
        Ok(())
    }

    /// Close the input and wait for FFmpeg to finalize the file.
    pub fn finish(mut self) -> Result<PathBuf> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin.flush().map_err(|e| {
                EngineError::Encode(format!("flushing frames: {e}: {}", self.stderr.snapshot()))
            })?;
        }
        let status = self.child.wait()?;
        let stderr = self.stderr.finish();
        if !status.success() {
            let _ = std::fs::remove_file(&self.path);
            return Err(EngineError::Encode(format!(
                "ffmpeg exited with {status}: {stderr}"
            )));
        }
        Ok(std::mem::take(&mut self.path))
    }

    /// Stop now and delete the partial file.
    pub fn abort(mut self) {
        self.stdin = None;
        kill(&mut self.child);
        let _ = std::fs::remove_file(&self.path);
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // `finish`/`abort` already reaped the child; otherwise never leave an
        // FFmpeg running behind a dropped encoder.
        if self.stdin.is_some() {
            self.stdin = None;
            kill(&mut self.child);
        }
    }
}
