//! Stream-copy muxer: Annex-B H.264 on stdin → MP4 via the ffmpeg sidecar.
//!
//! The editor WebView composes with Pixi and encodes with WebCodecs; Rust only
//! runs `ffmpeg -f h264 -i pipe:0 -c:v copy` so mux/IO stay out of WebView2
//! (the Windows export failure mode when mediabunny muxes in-process).

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const FFMPEG_FINISH_TIMEOUT: Duration = Duration::from_secs(60);
const FFMPEG_STDERR_CAP: usize = 64 * 1024;

/// Live ffmpeg session writing a partial MP4 beside the user destination.
pub struct H264StreamMuxer {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stderr_text: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    temp_path: PathBuf,
    final_path: PathBuf,
    bytes_written: u64,
    /// Set when `finish` / `abort` already cleaned up — skip [`Drop`] teardown.
    settled: bool,
}

impl H264StreamMuxer {
    pub fn spawn(final_path: &Path, fps: u32) -> AppResult<Self> {
        let temp_path = export_temp_path(final_path);
        if temp_path.exists() {
            let _ = std::fs::remove_file(&temp_path);
        }

        let ffmpeg = ffmpeg_path();
        let fps = fps.max(1);
        let fps_s = fps.to_string();
        // WebCodecs/VideoToolbox embeds VUI timing that the raw h264 demuxer
        // trusts over `-framerate`, producing ~700fps / sub-second duration.
        // Rewrite PTS/DTS/duration from the known CFR so the MP4 matches frame count.
        let bsf = format!("setts=pts=N/TB/{fps}:dts=N/TB/{fps}:duration=1/TB/{fps}");
        let timescale_s = (fps * 1000).to_string();
        let mut child = proc::command(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "h264",
                "-framerate",
                &fps_s,
                "-raw_packet_size",
                "1048576",
                "-i",
                "pipe:0",
                "-an",
                "-c:v",
                "copy",
                "-bsf:v",
                &bsf,
                "-video_track_timescale",
                &timescale_s,
                // Temp path ends in `.partial`, not `.mp4` — force the muxer.
                "-f",
                "mp4",
            ])
            .arg(&temp_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AppError::Encoder(format!(
                    "could not start ffmpeg h264 mux ({}): {e}",
                    ffmpeg.display()
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
            .name("ffmpeg-h264-stderr".into())
            .spawn({
                let buf = stderr_text.clone();
                move || drain_stderr(stderr, buf)
            })
            .ok();

        Ok(Self {
            child,
            stdin: Some(BufWriter::with_capacity(256 * 1024, raw_stdin)),
            stderr_text,
            stderr_reader,
            temp_path,
            final_path: final_path.to_path_buf(),
            bytes_written: 0,
            settled: false,
        })
    }

    pub fn write_chunk(&mut self, chunk: &[u8]) -> AppResult<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Encoder("ffmpeg stdin already closed".into()))?;
        if let Err(e) = stdin.write_all(chunk).and_then(|_| stdin.flush()) {
            let stderr = self.stderr_snapshot();
            let child_status = match self.child.try_wait() {
                Ok(Some(status)) => format!("exited {status}"),
                Ok(None) => "still running".into(),
                Err(err) => format!("status error: {err}"),
            };
            return Err(AppError::Encoder(format!(
                "ffmpeg h264 write failed: {e} ({child_status}){stderr_suffix}",
                stderr_suffix = if stderr.is_empty() {
                    String::new()
                } else {
                    format!("; {stderr}")
                }
            )));
        }
        self.bytes_written += chunk.len() as u64;
        Ok(())
    }

    /// Close stdin, wait for ffmpeg, promote temp → final. Returns final path.
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
                "ffmpeg h264 mux exited with {status}: {err}"
            )));
        }
        if self.bytes_written < 64 {
            let _ = std::fs::remove_file(&self.temp_path);
            return Err(AppError::Encoder(
                "ffmpeg h264 mux produced an empty video".into(),
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

impl Drop for H264StreamMuxer {
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

const EXPORT_PARTIAL_SUFFIX: &str = ".capptivo-export.partial";

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
                    "ffmpeg h264 mux timed out during finalize".into(),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                return Err(AppError::Encoder(format!(
                    "waiting on ffmpeg h264 mux failed: {e}"
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
}
