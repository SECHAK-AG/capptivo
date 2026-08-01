//! Linux capture via the xdg-desktop-portal ScreenCast interface + PipeWire —
//! the only path that works uniformly on Wayland and X11 (the same one OBS
//! uses). **This is the only file that drives the portal.**
//!
//! Ownership model: the compositor's portal dialog *is* the source picker on
//! Linux — apps cannot enumerate displays/windows or take thumbnails. So
//! `list_sources` returns a single "system picker" entry, and `start` runs the
//! portal negotiation (which shows the dialog on first use). A ScreenCast
//! `restore_token` is persisted so re-recording the same source doesn't
//! re-prompt every time.
//!
//! Threading mirrors the macOS/Windows backends: one dedicated thread owns the
//! whole session — a current-thread tokio runtime for the async portal calls
//! (zbus), then the blocking PipeWire main loop. Frames flow through the same
//! bounded channel; stop is delivered via a `pipewire::channel` (the only
//! Send-safe way to quit a PipeWire loop from outside).
//!
//! Cursor:
//! - **X11:** portal uses `Hidden`; `cursor::x11_probe` samples the pointer.
//! - **Wayland:** prefer portal `Metadata` (`SPA_META_Cursor` on each buffer)
//!   → publish into [`crate::cursor::portal_cursor_feed`] for the shared 60 Hz
//!   sampler. Fall back to `Embedded` when Metadata isn't advertised (no track;
//!   `tracks_cursor` stays false).

use super::pulse_audio::PulseMonitorTap;
use super::{CaptureBackend, CaptureHandle, RawFrame, CAPTURE_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::types::{CaptureSource, CaptureSourceKind, RecorderConfig};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use crossbeam_channel::Sender;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The single virtual source id — the portal dialog picks the real target.
const PORTAL_SOURCE_ID: &str = "portal:auto";

pub struct PortalBackend;

impl PortalBackend {
    pub fn new() -> Self {
        Self
    }
}

impl CaptureBackend for PortalBackend {
    fn is_supported(&self) -> bool {
        // A session D-Bus is the portal's transport; without one there is no
        // capture (headless/CI). Real availability surfaces at `start`.
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
            || std::env::var_os("XDG_RUNTIME_DIR").is_some()
    }

    /// The portal's own dialog is the permission flow; nothing to pre-check.
    fn has_permission(&self) -> bool {
        true
    }

    fn request_permission(&self) -> bool {
        true
    }

    fn list_sources(&self, _include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        // Enumeration is impossible under the portal model (by design on
        // Wayland). One entry; the frontend shows it as "choose in the system
        // picker" via `capabilities.can_enumerate_sources == false`.
        Ok(vec![CaptureSource {
            id: PORTAL_SOURCE_ID.into(),
            kind: CaptureSourceKind::Display,
            title: "Screen or window (system picker)".into(),
            width: 0,
            height: 0,
            is_primary: true,
            thumbnail: None,
        }])
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        if !config.source_id.starts_with("portal:") {
            return Err(AppError::InvalidSource(config.source_id.clone()));
        }

        let fps = config.fps.clamp(1, 120);
        let (tx, rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let (meta_tx, meta_rx) = crossbeam_channel::bounded::<SessionMeta>(1);
        let dropped = Arc::new(AtomicU64::new(0));

        // Send-safe quit signal into the (thread-bound) PipeWire loop.
        let (quit_tx, quit_rx) = pipewire::channel::channel::<()>();

        // Timestamp epoch shared with the cursor sampler (`CaptureHandle::epoch`).
        // ponytail: PipeWire buffers are stamped at dequeue time rather than
        // presentation time (this API exposes no pts) — a delivery-latency
        // error of a few ms, vs the hundreds of ms a first-frame rebase cost.
        let epoch = Instant::now();

        crate::cursor::portal_cursor_feed().clear();

        let producer_dropped = dropped.clone();
        std::thread::Builder::new()
            .name("portal-capture".into())
            .spawn(move || {
                if let Err(e) = run_session(tx, meta_tx, producer_dropped, quit_rx, epoch) {
                    tracing::warn!(%e, "portal capture session ended with error");
                }
                crate::cursor::portal_cursor_feed().clear();
            })
            .map_err(|e| AppError::Other(format!("failed to spawn capture thread: {e}")))?;

        // Rendezvous: the thread reports negotiated dimensions (or the portal
        // error, e.g. the user cancelled the dialog).
        let meta = meta_rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| AppError::Other("screen selection timed out".into()))?;
        let meta = match meta {
            SessionMeta::Ready(m) => m,
            SessionMeta::Failed(msg) => return Err(AppError::Other(msg)),
        };

        let stop = move || {
            let _ = quit_tx.send(());
        };
        let mut handle = CaptureHandle::new(meta.width, meta.height, fps, rx, dropped, stop);
        handle.capture_rect = crate::cursor::CaptureRect {
            x: meta.position.0,
            y: meta.position.1,
            width: f64::from(meta.width).max(1.0),
            height: f64::from(meta.height).max(1.0),
        };
        handle.scale_factor = 1.0;
        handle.epoch = epoch;
        // X11 probe always tracks; Wayland only when Metadata was negotiated.
        handle.tracks_cursor = meta.tracks_cursor;

        if config.capture_system_audio {
            match PulseMonitorTap::start() {
                Ok(tap) => {
                    let rx = tap.rx.clone();
                    handle.attach_audio(rx, move || drop(tap));
                }
                Err(e) => {
                    tracing::warn!(%e, "system audio unavailable; continuing video-only");
                }
            }
        }

        Ok(handle)
    }
}

/// What the capture thread reports back before frames flow.
enum SessionMeta {
    Ready(ReadyMeta),
    Failed(String),
}

struct ReadyMeta {
    width: u32,
    height: u32,
    /// Stream origin in compositor coordinates (matches the X11 pointer space
    /// on X11 sessions; added to stream-local Metadata cursor coords on Wayland).
    position: (f64, f64),
    tracks_cursor: bool,
}

/// Portal negotiation result handed from async-land to the PipeWire loop.
struct Negotiated {
    node_id: u32,
    fd: OwnedFd,
    position: (f64, f64),
    /// PipeWire buffers carry `SPA_META_Cursor` — publish into the cursor feed.
    cursor_via_metadata: bool,
}

fn run_session(
    tx: Sender<RawFrame>,
    meta_tx: Sender<SessionMeta>,
    dropped: Arc<AtomicU64>,
    quit_rx: pipewire::channel::Receiver<()>,
    epoch: Instant,
) -> AppResult<()> {
    // Async portal handshake on a private current-thread runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::Other(format!("tokio runtime: {e}")))?;

    let negotiated = match rt.block_on(negotiate_portal()) {
        Ok(n) => n,
        Err(e) => {
            let _ = meta_tx.send(SessionMeta::Failed(e.to_string()));
            return Err(e);
        }
    };

    // Hand off to the blocking PipeWire loop for the rest of the recording.
    if let Err(e) = run_pipewire(negotiated, tx, meta_tx.clone(), dropped, quit_rx, epoch) {
        let _ = meta_tx.send(SessionMeta::Failed(e.to_string()));
        return Err(e);
    }
    Ok(())
}

async fn negotiate_portal() -> AppResult<Negotiated> {
    let portal_err = |e: ashpd::Error| AppError::Other(format!("screen-cast portal: {e}"));

    let proxy = Screencast::new().await.map_err(portal_err)?;
    let session = proxy.create_session().await.map_err(portal_err)?;

    let (cursor_mode, cursor_via_metadata) = pick_cursor_mode(&proxy).await;
    tracing::info!(?cursor_mode, cursor_via_metadata, "portal cursor mode");

    let restore_token = load_restore_token();
    proxy
        .select_sources(
            &session,
            cursor_mode,
            SourceType::Monitor | SourceType::Window,
            false,
            restore_token.as_deref(),
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .map_err(portal_err)?;

    let response = proxy
        .start(&session, None)
        .await
        .map_err(portal_err)?
        .response()
        .map_err(|e| AppError::Other(format!("screen selection cancelled: {e}")))?;

    if let Some(token) = response.restore_token() {
        store_restore_token(token);
    }

    let stream = response
        .streams()
        .first()
        .ok_or_else(|| AppError::Other("portal returned no streams".into()))?
        .clone();
    let position = stream
        .position()
        .map(|(x, y)| (f64::from(x), f64::from(y)))
        .unwrap_or((0.0, 0.0));

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(portal_err)?;

    Ok(Negotiated {
        node_id: stream.pipe_wire_node_id(),
        fd,
        position,
        cursor_via_metadata,
    })
}

/// X11 → Hidden (X11 probe owns the track). Wayland → Metadata when the portal
/// advertises it, else Embedded (cursor painted in; no follow-zoom).
async fn pick_cursor_mode(proxy: &Screencast<'_>) -> (CursorMode, bool) {
    if !crate::capabilities::is_wayland() {
        return (CursorMode::Hidden, false);
    }
    match proxy.available_cursor_modes().await {
        Ok(modes) if modes.contains(CursorMode::Metadata) => (CursorMode::Metadata, true),
        Ok(_) => (CursorMode::Embedded, false),
        Err(e) => {
            tracing::debug!(%e, "available_cursor_modes failed; using Embedded");
            (CursorMode::Embedded, false)
        }
    }
}

/// Shared state for the PipeWire stream callbacks.
struct StreamState {
    format: Option<pipewire::spa::param::video::VideoInfoRaw>,
    announced: bool,
    cursor_via_metadata: bool,
    /// Stream origin — added to stream-local Metadata cursor coords.
    stream_origin: (f64, f64),
}

fn run_pipewire(
    negotiated: Negotiated,
    tx: Sender<RawFrame>,
    meta_tx: Sender<SessionMeta>,
    dropped: Arc<AtomicU64>,
    quit_rx: pipewire::channel::Receiver<()>,
    epoch: Instant,
) -> AppResult<()> {
    use pipewire::spa;
    use pipewire::stream::{Stream, StreamFlags};

    let pw_err = |e: pipewire::Error| AppError::Other(format!("pipewire: {e}"));

    let mainloop = pipewire::main_loop::MainLoop::new(None).map_err(pw_err)?;
    let context = pipewire::context::Context::new(&mainloop).map_err(pw_err)?;
    let core = context.connect_fd(negotiated.fd, None).map_err(pw_err)?;

    // Stop from the outside: quit the loop on the message.
    let loop_clone = mainloop.clone();
    let _quit_attach = quit_rx.attach(mainloop.loop_(), move |_| {
        loop_clone.quit();
    });

    let stream = Stream::new(
        &core,
        "capptivo-screen",
        pipewire::properties::properties! {
            *pipewire::keys::MEDIA_TYPE => "Video",
            *pipewire::keys::MEDIA_CATEGORY => "Capture",
            *pipewire::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(pw_err)?;

    let position = negotiated.position;
    let cursor_via_metadata = negotiated.cursor_via_metadata;
    // X11 always tracks via probe; Wayland only with Metadata.
    let tracks_cursor = cursor_via_metadata || !crate::capabilities::is_wayland();

    let _listener = stream
        .add_local_listener_with_user_data(StreamState {
            format: None,
            announced: false,
            cursor_via_metadata,
            stream_origin: position,
        })
        .param_changed(move |_stream, state, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let (media_type, media_subtype) =
                match spa::param::format_utils::parse_format(param) {
                    Ok(v) => v,
                    Err(_) => return,
                };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            let mut info = spa::param::video::VideoInfoRaw::new();
            if info.parse(param).is_ok() {
                // Announce negotiated dimensions exactly once so `start` can
                // size the encoder before the first frame.
                if !state.announced {
                    state.announced = true;
                    let _ = meta_tx.send(SessionMeta::Ready(ReadyMeta {
                        width: info.size().width,
                        height: info.size().height,
                        position: state.stream_origin,
                        tracks_cursor,
                    }));
                }
                state.format = Some(info);
            }
        })
        .process(move |stream, state| {
            let Some(format) = state.format else { return };
            let (width, height) = (format.size().width, format.size().height);
            // Raw dequeue so we can read SPA_META_Cursor (pipewire 0.8 Buffer
            // has no find_meta helper).
            loop {
                let raw = unsafe { stream.dequeue_raw_buffer() };
                if raw.is_null() {
                    break;
                }
                unsafe {
                    if state.cursor_via_metadata {
                        publish_cursor_meta(raw, state.stream_origin);
                    }
                    if let Some(frame) = raw_frame_from_pw(raw, width, height, epoch) {
                        match tx.try_send(frame) {
                            Ok(()) => {}
                            Err(crossbeam_channel::TrySendError::Full(_)) => {
                                dropped.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(crossbeam_channel::TrySendError::Disconnected(_)) => {
                                stream.queue_raw_buffer(raw);
                                return;
                            }
                        }
                    }
                    stream.queue_raw_buffer(raw);
                }
            }
        })
        .register()
        .map_err(pw_err)?;

    // Format + (when Metadata) cursor meta request — same idea as OBS.
    let format_bytes = build_format_pod()?;
    let meta_bytes = cursor_via_metadata
        .then(build_cursor_meta_pod)
        .transpose()?;
    let format_pod = spa::pod::Pod::from_bytes(&format_bytes)
        .ok_or_else(|| AppError::Other("format pod parse".into()))?;
    let meta_pod = meta_bytes
        .as_ref()
        .map(|b| {
            spa::pod::Pod::from_bytes(b)
                .ok_or_else(|| AppError::Other("cursor meta pod parse".into()))
        })
        .transpose()?;

    let mut params: Vec<&spa::pod::Pod> = Vec::with_capacity(2);
    params.push(format_pod);
    if let Some(p) = meta_pod {
        params.push(p);
    }

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(negotiated.node_id),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            params.as_mut_slice(),
        )
        .map_err(pw_err)?;

    mainloop.run();
    Ok(())
}

fn build_format_pod() -> AppResult<Vec<u8>> {
    use pipewire::spa;
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRA
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            spa::utils::Rectangle {
                width: 16384,
                height: 16384
            }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: 30, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map(|v| v.0.into_inner())
    .map_err(|e| AppError::Other(format!("format pod: {e:?}")))
}

/// Ask PipeWire for `SPA_META_Cursor` on buffers (OBS does the same).
fn build_cursor_meta_pod() -> AppResult<Vec<u8>> {
    use pipewire::spa;
    use pipewire::spa::sys as spa_sys;

    // spa_meta_cursor + spa_meta_bitmap + 64×64 ARGB — enough for position;
    // bitmap is optional for Capptivo (we only need x/y for zoom-follow).
    let meta_size = (std::mem::size_of::<spa_sys::spa_meta_cursor>()
        + std::mem::size_of::<spa_sys::spa_meta_bitmap>()
        + 64 * 64 * 4) as i32;

    let obj = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamMeta.as_raw(),
        id: spa::param::ParamType::Meta.as_raw(),
        properties: vec![
            spa::pod::Property::new(
                spa_sys::SPA_PARAM_META_type,
                spa::pod::Value::Id(spa::utils::Id(spa_sys::SPA_META_Cursor)),
            ),
            spa::pod::Property::new(spa_sys::SPA_PARAM_META_size, spa::pod::Value::Int(meta_size)),
        ],
    };
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map(|v| v.0.into_inner())
    .map_err(|e| AppError::Other(format!("cursor meta pod: {e:?}")))
}

/// Publish stream-local cursor metadata into the shared feed (capture-rect space).
unsafe fn publish_cursor_meta(pw_buf: *mut pipewire::sys::pw_buffer, stream_origin: (f64, f64)) {
    use pipewire::spa::sys as spa_sys;

    let spa_buf = (*pw_buf).buffer;
    if spa_buf.is_null() {
        return;
    }
    let meta = spa_sys::spa_buffer_find_meta_data(
        spa_buf,
        spa_sys::SPA_META_Cursor,
        std::mem::size_of::<spa_sys::spa_meta_cursor>(),
    ) as *const spa_sys::spa_meta_cursor;
    if meta.is_null() || (*meta).id == 0 {
        return;
    }
    let x = stream_origin.0 + f64::from((*meta).position.x);
    let y = stream_origin.1 + f64::from((*meta).position.y);
    crate::cursor::portal_cursor_feed().publish(x, y);
}

unsafe fn raw_frame_from_pw(
    pw_buf: *mut pipewire::sys::pw_buffer,
    width: u32,
    height: u32,
    epoch: Instant,
) -> Option<RawFrame> {
    let spa_buf = (*pw_buf).buffer;
    if spa_buf.is_null() || (*spa_buf).n_datas == 0 || (*spa_buf).datas.is_null() {
        return None;
    }
    let data = &*(*spa_buf).datas;
    if data.data.is_null() || data.chunk.is_null() {
        return None;
    }
    let chunk = &*data.chunk;
    let chunk_size = chunk.size as usize;
    if chunk_size == 0 {
        return None;
    }
    let bytes_per_row = if chunk.stride > 0 {
        chunk.stride as u32
    } else {
        width * 4
    };
    let slice = std::slice::from_raw_parts(data.data as *const u8, data.maxsize as usize);
    let len = chunk_size.min(slice.len());
    Some(RawFrame {
        width,
        height,
        bytes_per_row,
        data: slice[..len].to_vec(),
        timestamp: epoch.elapsed(),
    })
}

// --- restore-token persistence (skip re-prompting the portal dialog) --------

fn restore_token_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("capptivo").join("screencast-restore-token"))
}

fn load_restore_token() -> Option<String> {
    let path = restore_token_path()?;
    let token = std::fs::read_to_string(path).ok()?;
    let token = token.trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn store_restore_token(token: &str) {
    let Some(path) = restore_token_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, token) {
        tracing::debug!(%e, "failed to persist screencast restore token");
    }
}
