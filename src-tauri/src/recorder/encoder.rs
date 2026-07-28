//! H.264 encoder: raw BGRA frames in, a finalized MP4 out, via an FFmpeg
//! sidecar using the machine's probed hardware encoder (VideoToolbox on macOS,
//! NVENC/QSV/AMF/MediaFoundation on Windows, VAAPI/NVENC on Linux — see
//! [`crate::recorder::hw_encoder`]). Fragmented MP4 so a crash mid-recording
//! still leaves a playable file — see TAURI_DESKTOP_MIGRATION.md §15.
//!
//! System audio: PCM is appended to a sidecar during capture, then remuxed as AAC
//! on `finish` (`-c:v copy`). Avoids live dual-stdin deadlocks with FFmpeg.

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::hw_encoder;
use crate::recorder::types::QualityPreset;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::time::{Duration, Instant};

pub const SYSTEM_AUDIO_RATE: u32 = 48_000;
pub const SYSTEM_AUDIO_CHANNELS: u16 = 2;

const FFMPEG_FINISH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Encoder {
    child: Child,
    /// Buffered so a padded (strided) frame is one `write` + flush per frame,
    /// not one syscall per scanline.
    video_stdin: BufWriter<ChildStdin>,
    pcm: Option<File>,
    pcm_path: Option<PathBuf>,
    pcm_rate: u32,
    pcm_channels: u16,
    width: u32,
    height: u32,
    frame_len: usize,
    output: PathBuf,
}

impl Encoder {
    pub fn spawn(
        output: &Path,
        width: u32,
        height: u32,
        fps: u32,
        quality: QualityPreset,
        system_audio: bool,
    ) -> AppResult<Self> {
        let bitrate = quality.target_bitrate(width, height);
        let ffmpeg = ffmpeg_path();
        let encoder = hw_encoder::pick(&ffmpeg);

        let mut child = proc::command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(encoder.pre_input_args)
            .args([
                "-f",
                "rawvideo",
                "-pixel_format",
                "bgra",
                "-video_size",
                &format!("{width}x{height}"),
                "-framerate",
                &fps.to_string(),
                "-i",
                "-",
                "-c:v",
                encoder.name,
                "-b:v",
                &bitrate.to_string(),
            ])
            .args(encoder.output_args(None))
            .args(encoder.tuning_args)
            .args([
                "-r",
                &fps.to_string(),
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
            ])
            .arg(output)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                AppError::Encoder(format!(
                    "could not start ffmpeg ({}): {e}",
                    ffmpeg.display()
                ))
            })?;

        let raw_stdin = child.stdin.take().ok_or_else(|| {
            AppError::Encoder("ffmpeg stdin missing".into())
        })?;
        // One buffer wide enough to hold a whole frame keeps padded writes cheap.
        let video_stdin =
            BufWriter::with_capacity((width as usize) * (height as usize) * 4, raw_stdin);

        let (pcm, pcm_path) = if system_audio {
            let path = output.with_file_name("system.pcm");
            let file = File::create(&path).map_err(|e| {
                AppError::Encoder(format!("could not create system.pcm: {e}"))
            })?;
            (Some(file), Some(path))
        } else {
            (None, None)
        };

        Ok(Self {
            child,
            video_stdin,
            pcm,
            pcm_path,
            pcm_rate: SYSTEM_AUDIO_RATE,
            pcm_channels: SYSTEM_AUDIO_CHANNELS,
            width,
            height,
            frame_len: (width as usize) * (height as usize) * 4,
            output: output.to_path_buf(),
        })
    }

    pub fn write_frame(&mut self, data: &[u8], bytes_per_row: u32) -> AppResult<()> {
        let tight_row = (self.width as usize) * 4;
        let write_res = if bytes_per_row as usize == tight_row {
            debug_assert_eq!(data.len(), self.frame_len);
            self.video_stdin
                .write_all(&data[..self.frame_len.min(data.len())])
        } else {
            // Strip row padding: BufWriter coalesces the per-row copies into a
            // single frame-sized write when we flush below.
            let stride = bytes_per_row as usize;
            let mut res = Ok(());
            for row in 0..self.height as usize {
                let start = row * stride;
                let end = start + tight_row;
                if end > data.len() {
                    break;
                }
                if let Err(e) = self.video_stdin.write_all(&data[start..end]) {
                    res = Err(e);
                    break;
                }
            }
            res
        };

        write_res
            .and_then(|()| self.video_stdin.flush())
            .map_err(|e| AppError::Encoder(format!("write to ffmpeg failed: {e}")))
    }

    pub fn write_audio(&mut self, data: &[u8], sample_rate: u32, channels: u16) -> AppResult<()> {
        let Some(pcm) = self.pcm.as_mut() else {
            return Ok(());
        };
        if sample_rate > 0 {
            self.pcm_rate = sample_rate;
        }
        if channels > 0 {
            self.pcm_channels = channels;
        }
        pcm.write_all(data)
            .map_err(|e| AppError::Encoder(format!("write system audio failed: {e}")))
    }

    pub fn finish(mut self) -> AppResult<PathBuf> {
        // Flush any buffered tail, then close stdin so ffmpeg finalizes.
        let _ = self.video_stdin.flush();
        drop(self.video_stdin);

        let status = wait_child(&mut self.child, FFMPEG_FINISH_TIMEOUT)?;

        if !status.success() {
            let mut stderr = String::new();
            if let Some(mut err) = self.child.stderr.take() {
                use std::io::Read;
                let _ = err.read_to_string(&mut stderr);
            }
            return Err(AppError::Encoder(format!(
                "ffmpeg exited with {status}: {}",
                stderr.trim()
            )));
        }

        if let Some(pcm_path) = self.pcm_path.take() {
            if let Some(mut pcm) = self.pcm.take() {
                let _ = pcm.flush();
            }
            let bytes = fs::metadata(&pcm_path).map(|m| m.len()).unwrap_or(0);
            if bytes > 0 {
                mux_system_audio(
                    &self.output,
                    &pcm_path,
                    self.pcm_rate,
                    self.pcm_channels,
                )?;
            }
            let _ = fs::remove_file(&pcm_path);
        }

        Ok(self.output)
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> AppResult<std::process::ExitStatus> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Encoder(
                    "ffmpeg timed out during finalize".into(),
                ));
            }
            Err(e) => return Err(AppError::Encoder(format!("waiting on ffmpeg failed: {e}"))),
        }
    }
}

/// Mux narration from the recorder WebView into `screen.mp4` (mic-only or mixed with system audio).
pub fn attach_mic_audio(
    video_mp4: &Path,
    mic_webm: &Path,
    mix_with_system_audio: bool,
) -> AppResult<()> {
    if !video_mp4.is_file() || !mic_webm.is_file() {
        return Err(AppError::Encoder("mic mux: missing input file".into()));
    }
    let ffmpeg = ffmpeg_path();
    let tmp = video_mp4.with_extension("micmux.mp4");
    let mix = mix_with_system_audio && mp4_has_audio_stream(video_mp4);
    let status = if mix {
        proc::command(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
            ])
            .arg(video_mp4)
            .args(["-i"])
            .arg(mic_webm)
            .args([
                "-filter_complex",
                "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]",
                "-map",
                "0:v:0",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
            ])
            .arg(&tmp)
            .status()
    } else {
        proc::command(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
            ])
            .arg(video_mp4)
            .args(["-i"])
            .arg(mic_webm)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
            ])
            .arg(&tmp)
            .status()
    }
    .map_err(|e| AppError::Encoder(format!("mic mux spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Encoder(format!("mic mux failed with {status}")));
    }

    fs::rename(&tmp, video_mp4).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Encoder(format!("mic mux rename failed: {e}"))
    })
}

/// Finalize a completed recording into a standard, seekable progressive MP4.
///
/// Live capture writes *fragmented* MP4 (`empty_moov` + `moof`/`mdat`) so a crash
/// mid-recording still leaves a playable file. That format carries no total
/// duration or sample table in the front `moov`, so WebKit's `<video>` — used by
/// the editor's export seek path when the WebCodecs decoder isn't available —
/// can only seek within the fragments it has already demuxed and clamps every
/// later seek, freezing exports past the first few seconds.
///
/// Once the recording has stopped cleanly the crash-safety of fragmentation is
/// no longer needed, so we remux into a `+faststart` progressive MP4 with a full
/// front `moov`. This is a stream copy (no re-encode — sub-second even for large
/// files) and makes the file seekable in every consumer. Best-effort: on failure
/// the original fragmented file is kept intact (still playable).
pub fn finalize_recording_mp4(video_path: &Path) -> AppResult<()> {
    if !video_path.is_file() {
        return Err(AppError::Encoder("finalize: missing video".into()));
    }
    // Idempotent: already a progressive MP4 (new recordings, or one finalized on
    // a prior open) → nothing to do. Keeps this safe to call from any consumer.
    let fragmented = is_fragmented_mp4(video_path);
    tracing::info!(path = %video_path.display(), fragmented, "finalize_recording_mp4: checking");
    if !fragmented {
        return Ok(());
    }
    tracing::info!(path = %video_path.display(), "finalize_recording_mp4: remuxing fragmented → progressive");
    let ext = video_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let tmp = video_path.with_file_name(format!("capptivo-finalize-{}.{ext}", uuid::Uuid::new_v4()));

    let ffmpeg = ffmpeg_path();
    // `-c copy` keeps every stream (video + any already-muxed audio) byte-for-byte;
    // dropping the fragment flags and adding `+faststart` rewrites the container as
    // a normal progressive MP4 with the moov moved to the front.
    let status = proc::command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(video_path)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Encoder(format!("finalize spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Encoder(format!(
            "finalize remux failed with {status}"
        )));
    }
    fs::rename(&tmp, video_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Encoder(format!("finalize rename failed: {e}"))
    })?;
    tracing::info!(path = %video_path.display(), "finalize_recording_mp4: done (progressive)");
    Ok(())
}

/// Does this MP4 use fragmentation (`moof` boxes)? Our live capture writes a tiny
/// init `moov` followed by `moof`/`mdat` fragment pairs; a finalized progressive
/// file has a single `moov` + `mdat` and no `moof`. The first fragment sits right
/// after the init `moov`, so scanning the first top-level boxes is enough — no
/// need to read the whole file.
fn is_fragmented_mp4(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 64 * 1024];
    let n = f.read(&mut buf).unwrap_or(0);
    let buf = &buf[..n];

    let mut p = 0usize;
    while p + 8 <= buf.len() {
        let mut size = u32::from_be_bytes([buf[p], buf[p + 1], buf[p + 2], buf[p + 3]]) as u64;
        let typ = &buf[p + 4..p + 8];
        let mut header = 8usize;
        if size == 1 {
            // 64-bit largesize follows the type.
            if p + 16 > buf.len() {
                break;
            }
            size = u64::from_be_bytes(buf[p + 8..p + 16].try_into().unwrap());
            header = 16;
        }
        match typ {
            b"moof" => return true,      // fragmented
            b"mdat" => return false,     // media data reached with no moof → progressive
            _ => {}
        }
        if size < header as u64 {
            break; // size 0 (to EOF) or malformed — stop scanning
        }
        p += size as usize;
    }
    false
}

// ---------------------------------------------------------------------------
// Export audio: mux the recorded audio into a (video-only) export, trimmed to
// the kept segments, with an optional voice-enhancement chain.
// ---------------------------------------------------------------------------

/// Voice-enhancement preset applied to the exported audio track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEnhancePreset {
    Off,
    Podcast,
}

impl AudioEnhancePreset {
    pub fn parse(s: &str) -> Self {
        match s {
            "podcast" => Self::Podcast,
            _ => Self::Off,
        }
    }
}

/// The FFmpeg filter body for a preset, or `None` for a straight copy.
///
/// When the user opts into podcast enhance we always shape the track for voice.
/// `has_system_audio` only softens denoise/compression so mixed mic+desktop
/// audio is not washed out — it must not turn enhance into a near no-op
/// (that was the old behavior: system-audio recordings only got loudnorm).
fn build_enhance_chain(preset: AudioEnhancePreset, has_system_audio: bool) -> Option<String> {
    if preset == AudioEnhancePreset::Off {
        return None;
    }

    let mut chain: Vec<&str> = Vec::new();
    // Cut rumble / desk thumps before denoise so FFT noise reduction works on speech.
    chain.push("highpass=f=80");
    if has_system_audio {
        // Mixed mic + system: lighter denoise/compression so music/SFX survive.
        chain.push("afftdn=nr=6:nf=-25");
        chain.push("acompressor=threshold=-20dB:ratio=2.5:attack=8:release=150");
    } else {
        // Mic-only narration: stronger denoise + podcast compression.
        chain.push("afftdn=nr=12:nf=-20");
        chain.push("acompressor=threshold=-18dB:ratio=3:attack=5:release=120");
    }
    // Presence shelf — intelligibility without harshness.
    chain.push("equalizer=f=3000:t=q:w=1.2:g=2.5");
    // Speech-aware leveling (single-pass; more audible on short clips than EBU loudnorm alone).
    chain.push("speechnorm=e=12.5:r=0.0005:l=1");
    chain.push("alimiter=limit=0.95:level=false");
    Some(chain.join(","))
}

/// Build the `-filter_complex` that trims `input_label`'s audio to `segments`
/// (source seconds), concatenates them to match the trimmed video timeline, then
/// applies `enhance`. Returns `(filter_complex, map_label)`; an empty filter
/// means "map the raw stream" (the caller then omits `-filter_complex`).
fn build_audio_filtergraph(
    segments: &[(f64, f64)],
    enhance: Option<&str>,
    input_label: &str,
) -> (String, String) {
    if segments.is_empty() {
        return match enhance {
            Some(chain) => (format!("{input_label}{chain}[aout]"), "[aout]".into()),
            None => (String::new(), input_label.trim_start_matches('[').trim_end_matches(']').to_string()),
        };
    }

    let mut parts: Vec<String> = Vec::with_capacity(segments.len() + 2);
    for (i, (start, end)) in segments.iter().enumerate() {
        parts.push(format!(
            "{input_label}atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS[a{i}]"
        ));
    }
    let concat_inputs: String = (0..segments.len()).map(|i| format!("[a{i}]")).collect();
    parts.push(format!("{concat_inputs}concat=n={}:v=0:a=1[ac]", segments.len()));

    match enhance {
        Some(chain) => {
            parts.push(format!("[ac]{chain}[aout]"));
            (parts.join(";"), "[aout]".into())
        }
        None => (parts.join(";"), "[ac]".into()),
    }
}

fn audio_codec_for_ext(ext: &str) -> &'static str {
    if ext.eq_ignore_ascii_case("webm") {
        "libopus"
    } else {
        "aac"
    }
}

fn run_prepare_export_audio_inner(
    audio_source: &Path,
    out_path: &Path,
    segments: &[(f64, f64)],
    enhance: Option<&str>,
) -> AppResult<bool> {
    let (filter_complex, map_label) =
        build_audio_filtergraph(segments, enhance, "[0:a]");

    let ext = out_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4a");
    let audio_codec = audio_codec_for_ext(ext);

    let ffmpeg = ffmpeg_path();
    let mut cmd = proc::command(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(audio_source);
    if !filter_complex.is_empty() {
        cmd.args(["-filter_complex", &filter_complex]);
    }
    // When the filter is empty, map the raw stream; otherwise map the labeled pad.
    let map = if filter_complex.is_empty() {
        "0:a:0".to_string()
    } else {
        map_label
    };
    cmd.args(["-map", &map])
        .args(["-c:a", audio_codec, "-b:a", "192k"]);
    if audio_codec == "aac" {
        cmd.args(["-movflags", "+faststart"]);
    }
    let status = cmd
        .arg(out_path)
        .status()
        .map_err(|e| AppError::Encoder(format!("export audio prepare spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(out_path);
        return Err(AppError::Encoder(format!(
            "export audio prepare failed with {status}"
        )));
    }
    Ok(true)
}

/// Trim (+ optional enhance) recorded audio into `out_path` so the expensive
/// FFmpeg audio work can overlap the video encode. Returns `false` when there
/// is no audio track (caller keeps a silent video).
pub fn prepare_export_audio(
    audio_source: &Path,
    out_path: &Path,
    segments: &[(f64, f64)],
    preset: AudioEnhancePreset,
    has_system_audio: bool,
) -> AppResult<bool> {
    if !audio_source.is_file() || !mp4_has_audio_stream(audio_source) {
        return Ok(false);
    }

    let enhance = build_enhance_chain(preset, has_system_audio);
    if let Some(ref chain) = enhance {
        tracing::info!(
            %has_system_audio,
            filter = %chain,
            "export audio: applying podcast enhance"
        );
    }

    match run_prepare_export_audio_inner(audio_source, out_path, segments, enhance.as_deref()) {
        Ok(prepared) => Ok(prepared),
        Err(e) if enhance.is_some() => {
            tracing::warn!(
                error = %e,
                "export audio enhance failed; retrying without enhance"
            );
            run_prepare_export_audio_inner(audio_source, out_path, segments, None)
        }
        Err(e) => Err(e),
    }
}

/// Attach a previously prepared audio sidecar to a video-only export with
/// stream copy on both tracks (no re-encode).
pub fn attach_export_audio(video_path: &Path, audio_path: &Path) -> AppResult<()> {
    if !video_path.is_file() {
        return Err(AppError::Encoder("export audio attach: missing video".into()));
    }
    if !audio_path.is_file() {
        return Err(AppError::Encoder("export audio attach: missing audio".into()));
    }

    let ext = video_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let tmp = video_path.with_file_name(format!("capptivo-audiomux-{}.{ext}", uuid::Uuid::new_v4()));

    let ffmpeg = ffmpeg_path();
    let mut cmd = proc::command(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(video_path)
        .args(["-i"])
        .arg(audio_path)
        .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest"]);
    if ext.eq_ignore_ascii_case("mp4") {
        cmd.args(["-movflags", "+faststart"]);
    }
    let status = cmd
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Encoder(format!("export audio attach spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Encoder(format!(
            "export audio attach failed with {status}"
        )));
    }
    fs::rename(&tmp, video_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Encoder(format!("export audio attach rename failed: {e}"))
    })
}

/// Mux the recorded audio (`audio_source`, e.g. the project's `screen.mp4`) into
/// a video-only export at `video_path`, trimmed to `segments` and optionally
/// voice-enhanced. Video is stream-copied (no re-encode). No-op when the source
/// has no audio track.
pub fn mux_export_audio(
    video_path: &Path,
    audio_source: &Path,
    segments: &[(f64, f64)],
    preset: AudioEnhancePreset,
    has_system_audio: bool,
) -> AppResult<()> {
    if !video_path.is_file() {
        return Err(AppError::Encoder("export mux: missing video".into()));
    }
    // Silent recording → nothing to add; leave the video-only export as-is.
    if !audio_source.is_file() || !mp4_has_audio_stream(audio_source) {
        return Ok(());
    }

    let enhance = build_enhance_chain(preset, has_system_audio);
    if let Some(ref chain) = enhance {
        tracing::info!(
            %has_system_audio,
            filter = %chain,
            "export audio mux: applying podcast enhance"
        );
    }

    match run_mux_export_audio_inner(video_path, audio_source, segments, enhance.as_deref()) {
        Ok(()) => Ok(()),
        Err(e) if enhance.is_some() => {
            tracing::warn!(
                error = %e,
                "export audio mux enhance failed; retrying without enhance"
            );
            run_mux_export_audio_inner(video_path, audio_source, segments, None)
        }
        Err(e) => Err(e),
    }
}

fn run_mux_export_audio_inner(
    video_path: &Path,
    audio_source: &Path,
    segments: &[(f64, f64)],
    enhance: Option<&str>,
) -> AppResult<()> {
    let (filter_complex, map_label) =
        build_audio_filtergraph(segments, enhance, "[1:a]");

    let ext = video_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let audio_codec = audio_codec_for_ext(ext);
    let tmp = video_path.with_file_name(format!("capptivo-audiomux-{}.{ext}", uuid::Uuid::new_v4()));

    let ffmpeg = ffmpeg_path();
    let mut cmd = proc::command(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(video_path)
        .args(["-i"])
        .arg(audio_source);
    if !filter_complex.is_empty() {
        cmd.args(["-filter_complex", &filter_complex]);
    }
    let map = if filter_complex.is_empty() {
        "1:a".to_string()
    } else {
        map_label
    };
    cmd.args(["-map", "0:v:0", "-map", &map])
        .args(["-c:v", "copy", "-c:a", audio_codec, "-b:a", "192k", "-shortest"]);
    if audio_codec == "aac" {
        cmd.args(["-movflags", "+faststart"]);
    }
    let status = cmd
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Encoder(format!("export audio mux spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Encoder(format!(
            "export audio mux failed with {status}"
        )));
    }
    fs::rename(&tmp, video_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Encoder(format!("export audio mux rename failed: {e}"))
    })
}

fn mp4_has_audio_stream(path: &Path) -> bool {
    let ffprobe = ffprobe_path();
    let out = proc::command(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();
    match out {
        Ok(o) => o.status.success() && !o.stdout.is_empty(),
        Err(_) => false,
    }
}

fn mux_system_audio(
    video_mp4: &Path,
    pcm_path: &Path,
    sample_rate: u32,
    channels: u16,
) -> AppResult<()> {
    let ffmpeg = ffmpeg_path();
    let tmp = video_mp4.with_extension("mux.mp4");
    let status = proc::command(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
        ])
        .arg(video_mp4)
        .args([
            "-f",
            "f32le",
            "-ar",
            &sample_rate.to_string(),
            "-ac",
            &channels.to_string(),
            "-i",
        ])
        .arg(pcm_path)
        .args([
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
        ])
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Encoder(format!("system-audio mux spawn failed: {e}")))?;

    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Encoder(format!(
            "system-audio mux failed with {status}"
        )));
    }

    fs::rename(&tmp, video_mp4).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Encoder(format!("system-audio mux rename failed: {e}"))
    })
}

pub(crate) fn ffmpeg_path() -> PathBuf {
    proc::sidecar_or_path("ffmpeg")
}

pub(crate) fn ffprobe_path() -> PathBuf {
    proc::sidecar_or_path("ffprobe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhance_chain_off_is_none() {
        assert!(build_enhance_chain(AudioEnhancePreset::Off, false).is_none());
    }

    #[test]
    fn enhance_chain_mic_only_shapes_voice() {
        let c = build_enhance_chain(AudioEnhancePreset::Podcast, false).unwrap();
        assert!(c.contains("highpass"));
        assert!(c.contains("afftdn=nr=12"));
        assert!(c.contains("acompressor"));
        assert!(c.contains("equalizer=f=3000"));
        assert!(c.contains("speechnorm"));
        assert!(c.contains("alimiter"));
    }

    #[test]
    fn enhance_chain_with_system_audio_still_shapes_voice() {
        // Mixed track: gentler denoise, but still a real podcast chain (not loudnorm-only).
        let c = build_enhance_chain(AudioEnhancePreset::Podcast, true).unwrap();
        assert!(c.contains("highpass"));
        assert!(c.contains("afftdn=nr=6"));
        assert!(c.contains("acompressor"));
        assert!(c.contains("speechnorm"));
        assert!(c.contains("alimiter"));
    }

    #[test]
    fn filtergraph_trims_and_concats_segments() {
        let (f, map) =
            build_audio_filtergraph(&[(0.0, 1.5), (3.0, 4.0)], Some("loudnorm"), "[1:a]");
        assert!(f.contains("[1:a]atrim=start=0.000000:end=1.500000"));
        assert!(f.contains("atrim=start=3.000000:end=4.000000"));
        assert!(f.contains("concat=n=2:v=0:a=1[ac]"));
        assert!(f.contains("[ac]loudnorm[aout]"));
        assert_eq!(map, "[aout]");
    }

    #[test]
    fn filtergraph_without_enhance_maps_concat_output() {
        let (f, map) = build_audio_filtergraph(&[(0.0, 2.0)], None, "[0:a]");
        assert!(f.contains("[0:a]atrim="));
        assert!(f.contains("concat=n=1:v=0:a=1[ac]"));
        assert_eq!(map, "[ac]");
    }

    #[test]
    fn mux_helper_rejects_missing_inputs() {
        if proc::command(proc::exe_name("ffmpeg")).arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("capptivo-mux-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope.mp4");
        let pcm = dir.join("a.pcm");
        fs::write(&pcm, [0u8; 8]).unwrap();
        let err = mux_system_audio(&missing, &pcm, 48_000, 2).unwrap_err();
        assert!(err.to_string().contains("mux") || err.to_string().contains("ffmpeg"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Build a minimal MP4 prefix of top-level boxes `[(size, type)]`, padding
    /// each box body with zeros. Enough to exercise the `is_fragmented_mp4` scan.
    fn synth_mp4(boxes: &[(u32, &[u8; 4])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (size, typ) in boxes {
            out.extend_from_slice(&size.to_be_bytes());
            out.extend_from_slice(*typ);
            out.resize(out.len() + (*size as usize).saturating_sub(8), 0);
        }
        out
    }

    #[test]
    fn detects_fragmented_vs_progressive_mp4() {
        let dir = std::env::temp_dir().join(format!("capptivo-frag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        // Fragmented: tiny init moov, then a moof fragment.
        let frag = dir.join("frag.mp4");
        fs::write(
            &frag,
            synth_mp4(&[(28, b"ftyp"), (740, b"moov"), (152, b"moof"), (4096, b"mdat")]),
        )
        .unwrap();
        assert!(is_fragmented_mp4(&frag));

        // Progressive (faststart): moov then mdat, no moof.
        let prog = dir.join("prog.mp4");
        fs::write(
            &prog,
            synth_mp4(&[(32, b"ftyp"), (6680, b"moov"), (8, b"free"), (4096, b"mdat")]),
        )
        .unwrap();
        assert!(!is_fragmented_mp4(&prog));

        // A missing file is not fragmented (callers treat it as nothing to do).
        assert!(!is_fragmented_mp4(&dir.join("nope.mp4")));

        let _ = fs::remove_dir_all(&dir);
    }
}
