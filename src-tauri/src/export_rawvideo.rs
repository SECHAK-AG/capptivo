//! Path B export: RGBA frames on stdin → H.264 MP4 via the ffmpeg sidecar.
//!
//! The editor WebView still composes with Pixi (WYSIWYG with preview); Rust
//! encodes with the same [`hw_encoder`] pick used for recording so Windows
//! never depends on WebView2 `VideoEncoder`.

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use crate::recorder::hw_encoder;
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const FFMPEG_FINISH_TIMEOUT: Duration = Duration::from_secs(300);
const FFMPEG_STDERR_CAP: usize = 64 * 1024;
const EXPORT_PARTIAL_SUFFIX: &str = ".capptivo-export.partial";

/// Live ffmpeg session: raw RGBA in, encoded MP4 out (temp → final on finish).
pub struct RawvideoStreamEncoder {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stderr_text: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    temp_path: PathBuf,
    final_path: PathBuf,
    frame_bytes: usize,
    frames_written: u64,
    settled: bool,
}

impl RawvideoStreamEncoder {
    pub fn spawn(
        final_path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> AppResult<Self> {
        if width < 2 || height < 2 || width % 2 != 0 || height % 2 != 0 {
            return Err(AppError::Encoder(format!(
                "rawvideo export requires even dimensions ≥2 (got {width}x{height})"
            )));
        }

        let temp_path = export_temp_path(final_path);
        if temp_path.exists() {
            let _ = std::fs::remove_file(&temp_path);
        }

        let ffmpeg = ffmpeg_path();
        let encoder = hw_encoder::pick(&ffmpeg);
        let fps = fps.max(1);
        let bitrate = bitrate.max(500_000);
        let size = format!("{width}x{height}");
        let fps_s = fps.to_string();
        let bitrate_s = bitrate.to_string();

        let mut child = proc::command(&ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(encoder.pre_input_args)
            .args([
                "-f",
                "rawvideo",
                "-pixel_format",
                "rgba",
                "-video_size",
                &size,
                "-framerate",
                &fps_s,
                "-i",
                "pipe:0",
                "-an",
                "-c:v",
                encoder.name,
                "-b:v",
                &bitrate_s,
            ])
            .args(encoder.output_args(None))
            .args(encoder.tuning_args)
            .args(["-r", &fps_s, "-f", "mp4"])
            .arg(&temp_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AppError::Encoder(format!(
                    "could not start ffmpeg rawvideo encode ({} / {}): {e}",
                    ffmpeg.display(),
                    encoder.name
                ))
            })?;

        let raw_stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Encoder("ffmpeg stdin missing".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Encoder("ffmpeg stderr missing".into()))?;
        let stderr_text = Arc::new(Mutex::new(String::new()));
        let stderr_reader = std::thread::Builder::new()
            .name("ffmpeg-rawvideo-stderr".into())
            .spawn({
                let buf = stderr_text.clone();
                move || drain_stderr(stderr, buf)
            })
            .ok();

        let frame_bytes = (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4);

        tracing::info!(
            encoder = encoder.name,
            width,
            height,
            fps,
            bitrate,
            "rawvideo export started"
        );

        Ok(Self {
            child,
            stdin: Some(BufWriter::with_capacity(frame_bytes, raw_stdin)),
            stderr_text,
            stderr_reader,
            temp_path,
            final_path: final_path.to_path_buf(),
            frame_bytes,
            frames_written: 0,
            settled: false,
        })
    }

    pub fn write_frame(&mut self, chunk: &[u8]) -> AppResult<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        if chunk.len() != self.frame_bytes {
            return Err(AppError::Encoder(format!(
                "rawvideo frame size mismatch: got {} bytes, expected {}",
                chunk.len(),
                self.frame_bytes
            )));
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Encoder("ffmpeg stdin already closed".into()))?;
        if let Err(e) = stdin.write_all(chunk) {
            let stderr = self.stderr_snapshot();
            let child_status = match self.child.try_wait() {
                Ok(Some(status)) => format!("exited {status}"),
                Ok(None) => "still running".into(),
                Err(err) => format!("status error: {err}"),
            };
            return Err(AppError::Encoder(format!(
                "ffmpeg rawvideo write failed: {e} ({child_status}){stderr_suffix}",
                stderr_suffix = if stderr.is_empty() {
                    String::new()
                } else {
                    format!("; {stderr}")
                }
            )));
        }
        self.frames_written += 1;
        Ok(())
    }

    pub fn finish(mut self) -> AppResult<PathBuf> {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.flush();
            drop(stdin);
        }
        let status = wait_child(&mut self.child, FFMPEG_FINISH_TIMEOUT)?;
        if let Some(handle) = self.stderr_reader.take() {
            let _ = handle.join();
        }
        if !status.success() {
            let err = self.stderr_snapshot();
            let _ = std::fs::remove_file(&self.temp_path);
            return Err(AppError::Encoder(format!(
                "ffmpeg rawvideo encode exited with {status}: {err}"
            )));
        }
        if self.frames_written == 0 {
            let _ = std::fs::remove_file(&self.temp_path);
            return Err(AppError::Encoder(
                "ffmpeg rawvideo encode produced no frames".into(),
            ));
        }
        promote_temp_to_final(&self.temp_path, &self.final_path)?;
        self.settled = true;
        Ok(self.final_path.clone())
    }

    pub fn abort(mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(handle) = self.stderr_reader.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(&self.temp_path);
        self.settled = true;
    }

    fn stderr_snapshot(&self) -> String {
        self.stderr_text
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl Drop for RawvideoStreamEncoder {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.stdin.take();
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_file(&self.temp_path);
    }
}

fn export_temp_path(final_path: &Path) -> PathBuf {
    let mut os = final_path.as_os_str().to_os_string();
    os.push(EXPORT_PARTIAL_SUFFIX);
    PathBuf::from(os)
}

fn promote_temp_to_final(temp: &Path, final_path: &Path) -> AppResult<()> {
    if final_path.exists() {
        std::fs::remove_file(final_path)?;
    }
    std::fs::rename(temp, final_path).map_err(|e| {
        let _ = std::fs::remove_file(temp);
        AppError::Other(format!("export rename failed: {e}"))
    })?;
    Ok(())
}

fn drain_stderr(stderr: ChildStderr, buf: Arc<Mutex<String>>) {
    let mut reader = std::io::BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    continue;
                }
                let mut text = buf.lock().unwrap_or_else(|e| e.into_inner());
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(trimmed);
                if text.len() > FFMPEG_STDERR_CAP {
                    let drop = text.len() - FFMPEG_STDERR_CAP;
                    text.drain(..drop);
                }
            }
            Err(_) => break,
        }
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> AppResult<std::process::ExitStatus> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Encoder(
                    "ffmpeg rawvideo encode timed out during finalize".into(),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                return Err(AppError::Encoder(format!(
                    "waiting on ffmpeg rawvideo encode failed: {e}"
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_is_sidecar_beside_final() {
        let p = PathBuf::from("/tmp/out.mp4");
        let t = export_temp_path(&p);
        assert!(t
            .to_string_lossy()
            .ends_with(&format!("out.mp4{EXPORT_PARTIAL_SUFFIX}")));
    }

    #[test]
    fn rejects_odd_dimensions() {
        let err = RawvideoStreamEncoder::spawn(Path::new("/tmp/x.mp4"), 1921, 1080, 30, 8_000_000)
            .err()
            .expect("odd width must fail");
        assert!(err.to_string().contains("even dimensions"));
    }
}
