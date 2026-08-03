//! Global cursor tracking. Samples the pointer at ~60 Hz during a recording and
//! writes `cursor.json`, whose schema is a superset of what the editor engine's
//! `smartFollowCursor` / `zoomMotion` already consume.
//!
//! Position polling via Core Graphics needs **no** TCC permission. Click *events*
//! would need an event tap (Input Monitoring), so v1 records movement only and
//! degrades gracefully — zoom-follow works from motion alone (§11).

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

/// One cursor sample, normalized to the captured source rect (0..1) so the editor
/// is resolution-independent. `t` is seconds since record-start (`t0`), shared
/// with the video's frame timestamps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorSample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub kind: CursorKind,
    /// System cursor shape at sample time (ground truth from AppKit). Omitted
    /// from JSON when `Default` to keep tracks lean; absent in old recordings.
    #[serde(default, skip_serializing_if = "CursorShape::is_default")]
    pub shape: CursorShape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorKind {
    Move,
    Down,
    Up,
}

/// The *system* cursor shape shown on screen, captured per sample so the editor
/// can replay the real pointer (I-beam over text, pointing hand over links,
/// resize arrows at edges, open/closed hand while grabbing) instead of
/// guessing from motion.
///
/// Serde names must match the editor's `CURSOR_SHAPE_IDS` and the glyph files
/// under `public/cursors/<theme>/`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorShape {
    #[default]
    Default,
    /// Link/pointing hand (`NSCursor.pointingHand`).
    Pointer,
    /// Text insertion I-beam (`NSCursor.iBeam`).
    Text,
    /// Open hand — hovering something draggable (`NSCursor.openHand`).
    Grab,
    /// Closed hand — actively dragging (`NSCursor.closedHand`).
    Grabbing,
    Crosshair,
    /// Horizontal resize (column edges, split views, window left/right edges).
    #[serde(rename = "resize-ew")]
    ResizeEw,
    /// Vertical resize.
    #[serde(rename = "resize-ns")]
    ResizeNs,
    /// Diagonal resize, ↗↙.
    #[serde(rename = "resize-nesw")]
    ResizeNesw,
    /// Diagonal resize, ↖↘.
    #[serde(rename = "resize-nwse")]
    ResizeNwse,
    #[serde(rename = "not-allowed")]
    NotAllowed,
    /// Drag-link badge (`NSCursor.dragLink`).
    Alias,
    /// Drag-copy badge (`NSCursor.dragCopy`).
    Copy,
    #[serde(rename = "context-menu")]
    ContextMenu,
}

impl CursorShape {
    fn is_default(&self) -> bool {
        *self == CursorShape::Default
    }
}

/// The persisted `cursor.json` document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTrack {
    /// Capture rect in global points — lets the editor map back if it ever needs
    /// unnormalized coords, and documents the space the samples were taken in.
    pub capture_rect: CaptureRect,
    /// Display backing scale factor (points → pixels).
    pub scale_factor: f64,
    pub samples: Vec<CursorSample>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Sampling rate. 60 Hz is smooth enough for zoom-follow without wasting CPU.
const SAMPLE_HZ: f64 = 60.0;

/// A running cursor tracker. Drop or call [`CursorTracker::stop`] to end sampling
/// and collect the track.
pub struct CursorTracker {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<Vec<CursorSample>>>,
    rect: CaptureRect,
    scale_factor: f64,
}

impl CursorTracker {
    /// Start sampling, normalizing positions against `rect` (the capture rect in
    /// global points).
    pub fn start(rect: CaptureRect, scale_factor: f64, t0: Instant) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let handle = spawn_sampler(rect, t0, stop.clone());
        Self {
            stop,
            handle,
            rect,
            scale_factor,
        }
    }

    /// A tracker that never samples, for capture sources where the Mac's pointer
    /// is meaningless — iOS device capture records the *phone's* screen, so the
    /// desktop cursor must not be written onto that timeline.
    pub fn disabled(rect: CaptureRect, scale_factor: f64) -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(true)),
            handle: None,
            rect,
            scale_factor,
        }
    }

    /// Stop sampling and return the completed track.
    pub fn stop(mut self) -> CursorTrack {
        self.stop.store(true, Ordering::Relaxed);
        let samples = self
            .handle
            .take()
            .and_then(|h| h.join().ok())
            .unwrap_or_default();
        CursorTrack {
            capture_rect: self.rect,
            scale_factor: self.scale_factor,
            samples,
        }
    }

    #[cfg(test)]
    fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
}

impl Drop for CursorTracker {
    /// `stop()` is the normal path and consumes the tracker; this only fires
    /// when an early return or a panic drops it instead. Without it the 60 Hz
    /// sampler thread survives for the rest of the process lifetime, still
    /// growing its sample `Vec`.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Platform probes. One shared fixed-cadence loop below; each OS only supplies
// a `PointerProbe` (position + button + shape). Missing platform → no probe →
// an empty track, and the editor degrades gracefully (no cursor replay).
// ---------------------------------------------------------------------------

/// One tick's view of the primary button.
struct ButtonSample {
    /// Currently held.
    held: bool,
    /// Complete press+release pairs that happened *entirely between ticks* —
    /// polled state alone misses them (a trackpad tap is ~10 ms, well under
    /// one 60 Hz interval), which is how clicks used to vanish from the track.
    missed_taps: u32,
}

/// A per-tick view of the global pointer, in the same coordinate space as the
/// backend's `capture_rect` (points on macOS, physical pixels elsewhere).
trait PointerProbe {
    fn location(&mut self) -> Option<(f64, f64)>;
    /// Poll the button once for this tick (state + between-tick tap count).
    fn button(&mut self) -> ButtonSample;
    /// The on-screen cursor shape. Implementations may self-throttle expensive
    /// probes and return a cached value.
    fn shape(&mut self) -> CursorShape;
}

/// A shape change must survive this many consecutive ticks (~120 ms) before it
/// lands in the track. `NSCursor.currentSystemCursor` (and the Win32 cursor
/// during clicks) can report one-probe transients — hand / closed-hand blips
/// that replay as visible flicker in the editor. Real hovers last far longer,
/// and the editor crossfades shape transitions anyway, so the confirmation
/// latency is imperceptible. At the macOS 10 Hz probe cadence (one probe per
/// 6 ticks), 7 ticks means "seen by two consecutive probes".
const SHAPE_STABLE_TICKS: u32 = 7;

/// Suppresses single-probe shape glitches: a new shape only becomes the
/// recorded shape after it has been reported for [`SHAPE_STABLE_TICKS`]
/// consecutive ticks.
struct ShapeDebouncer {
    settled: CursorShape,
    candidate: CursorShape,
    streak: u32,
}

impl ShapeDebouncer {
    fn new() -> Self {
        Self {
            settled: CursorShape::Default,
            candidate: CursorShape::Default,
            streak: 0,
        }
    }

    fn feed(&mut self, raw: CursorShape) -> CursorShape {
        if raw == self.settled {
            // Back to (or still at) the settled shape — drop any candidate.
            self.candidate = raw;
            self.streak = 0;
        } else if raw == self.candidate {
            self.streak += 1;
            if self.streak >= SHAPE_STABLE_TICKS {
                self.settled = raw;
                self.streak = 0;
            }
        } else {
            self.candidate = raw;
            self.streak = 1;
        }
        self.settled
    }
}

fn spawn_sampler(
    rect: CaptureRect,
    t0: Instant,
    stop: Arc<AtomicBool>,
) -> Option<JoinHandle<Vec<CursorSample>>> {
    match std::thread::Builder::new()
        .name("cursor-tracker".into())
        .spawn(move || match platform_probe() {
            Some(probe) => run_sampler_loop(probe, rect, t0, &stop),
            // No pointer source on this platform/session.
            None => Vec::new(),
        }) {
        Ok(handle) => Some(handle),
        Err(e) => {
            tracing::warn!(error = %e, "cursor tracker spawn failed; recording without cursor replay");
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_probe() -> Option<Box<dyn PointerProbe>> {
    macos_probe::MacProbe::new().map(|p| Box::new(p) as Box<dyn PointerProbe>)
}

#[cfg(target_os = "windows")]
fn platform_probe() -> Option<Box<dyn PointerProbe>> {
    Some(Box::new(win_probe::WinProbe::new()))
}

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
fn platform_probe() -> Option<Box<dyn PointerProbe>> {
    if let Some(p) = x11_probe::X11Probe::new() {
        return Some(Box::new(p));
    }
    // Wayland: positions come from PipeWire SPA_META_Cursor (portal Metadata mode).
    Some(Box::new(portal_meta_probe::PortalMetaProbe))
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    all(target_os = "linux", feature = "portal-capture")
)))]
fn platform_probe() -> Option<Box<dyn PointerProbe>> {
    None
}

/// The shared sampling loop: fixed 60 Hz cadence, samples on movement, button
/// edges, and shape changes — identical semantics on every platform.
fn run_sampler_loop(
    mut probe: Box<dyn PointerProbe>,
    rect: CaptureRect,
    t0: Instant,
    stop: &AtomicBool,
) -> Vec<CursorSample> {
    let mut samples = Vec::new();
    let interval = std::time::Duration::from_secs_f64(1.0 / SAMPLE_HZ);
    let (mut last_x, mut last_y) = (f64::NAN, f64::NAN);
    let mut last_shape = CursorShape::Default;
    let mut last_button = probe.button().held;
    let mut shape_debounce = ShapeDebouncer::new();

    // Aim at a fixed cadence: advance a monotonic target each tick so
    // `sleep + work > interval` doesn't accumulate drift into sub-60 Hz.
    let mut next_tick = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if let Some((px, py)) = probe.location() {
            // Normalize to the capture rect; skip samples outside it.
            if rect.width > 0.0 && rect.height > 0.0 {
                let nx = (px - rect.x) / rect.width;
                let ny = (py - rect.y) / rect.height;
                let shape = shape_debounce.feed(probe.shape());
                let ButtonSample { held: button, missed_taps } = probe.button();
                let moved = nx != last_x || ny != last_y;
                let t = t0.elapsed().as_secs_f64();
                let (cx, cy) = (nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0));

                // A full press+release happened between ticks (trackpad tap):
                // synthesize the Down/Up pair so the click bounce still plays.
                // Only when the polled state shows no edge — otherwise the
                // edge logic below already represents the transition.
                if missed_taps > 0 && button == last_button && !button {
                    samples.push(CursorSample { t, x: cx, y: cy, kind: CursorKind::Down, shape });
                    samples.push(CursorSample { t, x: cx, y: cy, kind: CursorKind::Up, shape });
                    last_x = nx;
                    last_y = ny;
                    last_shape = shape;
                }

                // Button edges become Down/Up samples (real clicks — the
                // editor's click bounce and idle-reveal read these). Otherwise
                // record on movement or on a shape change, so hover-only
                // transitions (arrow → I-beam) land even with a still cursor.
                if button != last_button || moved || shape != last_shape {
                    samples.push(CursorSample {
                        t,
                        x: cx,
                        y: cy,
                        kind: if button != last_button {
                            if button {
                                CursorKind::Down
                            } else {
                                CursorKind::Up
                            }
                        } else {
                            CursorKind::Move
                        },
                        shape,
                    });
                    last_x = nx;
                    last_y = ny;
                    last_shape = shape;
                    last_button = button;
                }
            }
        }

        next_tick += interval;
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        } else {
            // Fell behind (e.g. after a stall) — resync to now.
            next_tick = now;
        }
    }
    samples
}

// ---------------------------------------------------------------------------
// macOS: CoreGraphics position/button polling (no TCC needed) + NSCursor
// image-hash shape classification.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos_probe {
    use super::{ButtonSample, CursorShape, PointerProbe};
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // Polls the left mouse button without an event tap, so no Input Monitoring
    // TCC prompt (unlike `CGEventTap`). `stateID` 0 = combined session state.
    // The event *counters* are the tap-proof half: they increment for every
    // down/up regardless of duration, so a ~10 ms trackpad tap that falls
    // entirely between two 60 Hz state polls is still observed.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
        fn CGEventSourceCounterForEventType(state_id: i32, event_type: u32) -> u32;
    }

    const COMBINED_SESSION_STATE: i32 = 0;
    const LEFT_BUTTON: u32 = 0;
    /// `kCGEventLeftMouseDown` / `kCGEventLeftMouseUp`.
    const EVENT_LEFT_MOUSE_DOWN: u32 = 1;
    const EVENT_LEFT_MOUSE_UP: u32 = 2;

    fn left_button_down() -> bool {
        unsafe { CGEventSourceButtonState(COMBINED_SESSION_STATE, LEFT_BUTTON) }
    }

    fn event_count(event_type: u32) -> u32 {
        unsafe { CGEventSourceCounterForEventType(COMBINED_SESSION_STATE, event_type) }
    }

    pub struct MacProbe {
        /// Created once; each tick only retains it (a cheap CFRetain via clone)
        /// to read the pointer, rather than allocating a fresh source + event
        /// pair 60×/s for the whole recording.
        source: CGEventSource,
        // Shape probing round-trips WindowServer (`currentSystemCursor` +
        // image encode); doing it every tick can stall the loop and starve
        // *position* sampling. 10 Hz is plenty: shapes change at UI speed and
        // the editor crossfades transitions anyway.
        #[cfg(feature = "scap-capture")]
        classifier: shape_probe::ShapeClassifier,
        tick: u32,
        cached_shape: CursorShape,
        down_count: u32,
        up_count: u32,
    }

    #[cfg(feature = "scap-capture")]
    const SHAPE_PROBE_EVERY_TICKS: u32 = 6;

    impl MacProbe {
        pub fn new() -> Option<Self> {
            let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
            Some(Self {
                source,
                #[cfg(feature = "scap-capture")]
                classifier: shape_probe::ShapeClassifier::new(),
                tick: 0,
                cached_shape: CursorShape::Default,
                down_count: event_count(EVENT_LEFT_MOUSE_DOWN),
                up_count: event_count(EVENT_LEFT_MOUSE_UP),
            })
        }
    }

    impl PointerProbe for MacProbe {
        fn location(&mut self) -> Option<(f64, f64)> {
            let event = CGEvent::new(self.source.clone()).ok()?;
            let p = event.location();
            Some((p.x, p.y))
        }

        fn button(&mut self) -> ButtonSample {
            let held = left_button_down();
            let downs = event_count(EVENT_LEFT_MOUSE_DOWN);
            let ups = event_count(EVENT_LEFT_MOUSE_UP);
            let new_downs = downs.wrapping_sub(self.down_count);
            let new_ups = ups.wrapping_sub(self.up_count);
            self.down_count = downs;
            self.up_count = ups;
            ButtonSample {
                held,
                missed_taps: new_downs.min(new_ups),
            }
        }

        fn shape(&mut self) -> CursorShape {
            #[cfg(feature = "scap-capture")]
            {
                if self.tick % SHAPE_PROBE_EVERY_TICKS == 0 {
                    self.cached_shape = self.classifier.current();
                }
            }
            self.tick = self.tick.wrapping_add(1);
            self.cached_shape
        }
    }

    /// Classifies the on-screen system cursor by matching
    /// `NSCursor.currentSystemCursor` against the standard AppKit cursors —
    /// ground truth, not inference.
    ///
    /// Comparison is by FNV-1a hash of the cursor image's TIFF bytes: the
    /// standard cursors are singletons but `currentSystemCursor` wraps a fresh
    /// instance each call, so pointer identity can't work. Hashing a ~32×32
    /// image is a few µs on this dedicated thread. Unknown cursors (crosshair,
    /// resize, app-custom) fall back to `Default` — the editor then draws the
    /// user's chosen arrow style.
    #[cfg(feature = "scap-capture")]
    mod shape_probe {
        use super::super::CursorShape;
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};

        type Id = *mut Object;

        unsafe fn cursor_image_hash(cursor: Id) -> Option<u64> {
            if cursor.is_null() {
                return None;
            }
            let image: Id = msg_send![cursor, image];
            if image.is_null() {
                return None;
            }
            let tiff: Id = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return None;
            }
            let bytes: *const u8 = msg_send![tiff, bytes];
            let len: usize = msg_send![tiff, length];
            if bytes.is_null() || len == 0 {
                return None;
            }
            let data = std::slice::from_raw_parts(bytes, len);
            let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
            for &b in data {
                hash = (hash ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
            }
            Some(hash)
        }

        pub struct ShapeClassifier {
            known: Vec<(u64, CursorShape)>,
        }

        impl ShapeClassifier {
            /// Hash the standard cursors once. AppKit's cursor singletons are
            /// read-only; sampling them off-main is the same pattern other
            /// screen recorders use and needs no main-thread hop at 60 Hz.
            pub fn new() -> Self {
                let mut known = Vec::new();
                objc::rc::autoreleasepool(|| unsafe {
                    let mut add = |cursor: Id, shape: CursorShape| {
                        if let Some(hash) = cursor_image_hash(cursor) {
                            known.push((hash, shape));
                        }
                    };

                    // Public AppKit standard cursors.
                    add(msg_send![class!(NSCursor), IBeamCursor], CursorShape::Text);
                    add(
                        msg_send![class!(NSCursor), IBeamCursorForVerticalLayout],
                        CursorShape::Text,
                    );
                    add(msg_send![class!(NSCursor), pointingHandCursor], CursorShape::Pointer);
                    add(msg_send![class!(NSCursor), openHandCursor], CursorShape::Grab);
                    add(msg_send![class!(NSCursor), closedHandCursor], CursorShape::Grabbing);
                    add(msg_send![class!(NSCursor), crosshairCursor], CursorShape::Crosshair);
                    add(
                        msg_send![class!(NSCursor), operationNotAllowedCursor],
                        CursorShape::NotAllowed,
                    );
                    add(msg_send![class!(NSCursor), dragLinkCursor], CursorShape::Alias);
                    add(msg_send![class!(NSCursor), dragCopyCursor], CursorShape::Copy);
                    add(
                        msg_send![class!(NSCursor), contextualMenuCursor],
                        CursorShape::ContextMenu,
                    );
                    // Classic black resize arrows (split views, table columns).
                    add(msg_send![class!(NSCursor), resizeLeftRightCursor], CursorShape::ResizeEw);
                    add(msg_send![class!(NSCursor), resizeLeftCursor], CursorShape::ResizeEw);
                    add(msg_send![class!(NSCursor), resizeRightCursor], CursorShape::ResizeEw);
                    add(msg_send![class!(NSCursor), resizeUpDownCursor], CursorShape::ResizeNs);
                    add(msg_send![class!(NSCursor), resizeUpCursor], CursorShape::ResizeNs);
                    add(msg_send![class!(NSCursor), resizeDownCursor], CursorShape::ResizeNs);

                    // Window-edge resize cursors — the shape users actually see
                    // at window borders — have no public accessors. Probe the
                    // known class methods defensively: absent on some OS
                    // release simply means that shape is never classified.
                    let private: [(&str, CursorShape); 12] = [
                        ("_windowResizeEastWestCursor", CursorShape::ResizeEw),
                        ("_windowResizeNorthSouthCursor", CursorShape::ResizeNs),
                        ("_windowResizeNorthEastSouthWestCursor", CursorShape::ResizeNesw),
                        ("_windowResizeNorthWestSouthEastCursor", CursorShape::ResizeNwse),
                        ("_windowResizeEastCursor", CursorShape::ResizeEw),
                        ("_windowResizeWestCursor", CursorShape::ResizeEw),
                        ("_windowResizeNorthCursor", CursorShape::ResizeNs),
                        ("_windowResizeSouthCursor", CursorShape::ResizeNs),
                        ("_windowResizeNorthEastCursor", CursorShape::ResizeNesw),
                        ("_windowResizeSouthWestCursor", CursorShape::ResizeNesw),
                        ("_windowResizeNorthWestCursor", CursorShape::ResizeNwse),
                        ("_windowResizeSouthEastCursor", CursorShape::ResizeNwse),
                    ];
                    for (name, shape) in private {
                        let sel = objc::runtime::Sel::register(name);
                        let responds: bool =
                            msg_send![class!(NSCursor), respondsToSelector: sel];
                        if responds {
                            add(msg_send![class!(NSCursor), performSelector: sel], shape);
                        }
                    }
                });
                Self { known }
            }

            pub fn current(&self) -> CursorShape {
                if self.known.is_empty() {
                    return CursorShape::Default;
                }
                objc::rc::autoreleasepool(|| unsafe {
                    let cursor: Id = msg_send![class!(NSCursor), currentSystemCursor];
                    match cursor_image_hash(cursor) {
                        Some(hash) => self
                            .known
                            .iter()
                            .find(|(known, _)| *known == hash)
                            .map(|(_, shape)| *shape)
                            .unwrap_or(CursorShape::Default),
                        None => CursorShape::Default,
                    }
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: Win32 polling. Positions are physical virtual-desktop pixels
// (Tauri runs per-monitor-DPI-aware), matching the WGC backend's
// `capture_rect`. Shape classification is *simpler* than macOS: the standard
// cursors are process-wide singletons, so `HCURSOR` identity works.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win_probe {
    use super::{ButtonSample, CursorShape, PointerProbe};
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, GetCursorPos, LoadCursorW, CURSORINFO, HCURSOR, IDC_CROSS, IDC_HAND,
        IDC_IBEAM, IDC_NO, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE,
    };

    pub struct WinProbe {
        /// (standard cursor handle, shape) — resolved once. Windows has no
        /// standard grab/grabbing cursors; those stay app-specific and fall
        /// back to `Default`, same as unknown cursors on macOS.
        known: Vec<(HCURSOR, CursorShape)>,
        prev_held: bool,
    }

    impl WinProbe {
        pub fn new() -> Self {
            let mut known = Vec::new();
            let pairs = [
                (IDC_IBEAM, CursorShape::Text),
                (IDC_HAND, CursorShape::Pointer),
                (IDC_CROSS, CursorShape::Crosshair),
                (IDC_NO, CursorShape::NotAllowed),
                (IDC_SIZEWE, CursorShape::ResizeEw),
                (IDC_SIZENS, CursorShape::ResizeNs),
                (IDC_SIZENESW, CursorShape::ResizeNesw),
                (IDC_SIZENWSE, CursorShape::ResizeNwse),
            ];
            for (idc, shape) in pairs {
                if let Ok(handle) = unsafe { LoadCursorW(None, idc) } {
                    known.push((handle, shape));
                }
            }
            Self {
                known,
                prev_held: false,
            }
        }
    }

    impl PointerProbe for WinProbe {
        fn location(&mut self) -> Option<(f64, f64)> {
            let mut p = POINT::default();
            unsafe { GetCursorPos(&mut p) }.ok()?;
            Some((f64::from(p.x), f64::from(p.y)))
        }

        fn button(&mut self) -> ButtonSample {
            // High bit = currently down; low bit = "pressed since last call"
            // (best-effort — documented as shared state, but a caught trackpad
            // tap beats a missed one). Poll-not-hook, like macOS.
            let state = unsafe { GetAsyncKeyState(VK_LBUTTON.0.into()) } as u16;
            let held = (state & 0x8000) != 0;
            let tapped_between = (state & 0x0001) != 0 && !held && !self.prev_held;
            self.prev_held = held;
            ButtonSample {
                held,
                missed_taps: u32::from(tapped_between),
            }
        }

        fn shape(&mut self) -> CursorShape {
            let mut info = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                ..Default::default()
            };
            if unsafe { GetCursorInfo(&mut info) }.is_err() {
                return CursorShape::Default;
            }
            self.known
                .iter()
                .find(|(handle, _)| *handle == info.hCursor)
                .map(|(_, shape)| *shape)
                .unwrap_or(CursorShape::Default)
        }
    }
}

// ---------------------------------------------------------------------------
// Linux (X11 sessions): one XCB round-trip per tick returns position + button
// mask together. Wayland has no global pointer — the portal Metadata path
// publishes into [`portal_cursor_feed`] instead (see `portal_backend`).
// ---------------------------------------------------------------------------

/// Latest cursor position from PipeWire `SPA_META_Cursor` during a portal
/// Metadata capture. Polled by [`portal_meta_probe`] at 60 Hz — same cadence
/// as X11/Win/mac, so the editor pipeline stays identical.
#[cfg(all(target_os = "linux", feature = "portal-capture"))]
pub struct PortalCursorFeed {
    latest: parking_lot::Mutex<Option<(f64, f64)>>,
}

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
impl PortalCursorFeed {
    fn new() -> Self {
        Self {
            latest: parking_lot::Mutex::new(None),
        }
    }

    pub fn clear(&self) {
        *self.latest.lock() = None;
    }

    /// Compositor / capture-rect space (same as X11 root coords).
    pub fn publish(&self, x: f64, y: f64) {
        *self.latest.lock() = Some((x, y));
    }

    pub fn peek(&self) -> Option<(f64, f64)> {
        *self.latest.lock()
    }
}

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
pub fn portal_cursor_feed() -> &'static PortalCursorFeed {
    use std::sync::OnceLock;
    static FEED: OnceLock<PortalCursorFeed> = OnceLock::new();
    FEED.get_or_init(PortalCursorFeed::new)
}

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
mod portal_meta_probe {
    use super::{portal_cursor_feed, ButtonSample, CursorShape, PointerProbe};

    pub struct PortalMetaProbe;

    impl PointerProbe for PortalMetaProbe {
        fn location(&mut self) -> Option<(f64, f64)> {
            portal_cursor_feed().peek()
        }

        fn button(&mut self) -> ButtonSample {
            // SPA_META_Cursor carries position (and optional bitmap), not buttons.
            // Zoom-follow works from motion alone.
            ButtonSample {
                held: false,
                missed_taps: 0,
            }
        }

        fn shape(&mut self) -> CursorShape {
            CursorShape::Default
        }
    }
}

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
mod x11_probe {
    use super::{ButtonSample, CursorShape, PointerProbe};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, KeyButMask};
    use x11rb::rust_connection::RustConnection;

    pub struct X11Probe {
        conn: RustConnection,
        root: u32,
    }

    impl X11Probe {
        /// `None` on Wayland (or headless) — sampler falls back to portal meta.
        pub fn new() -> Option<Self> {
            if crate::capabilities::is_wayland() {
                return None;
            }
            let (conn, screen_num) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen_num)?.root;
            Some(Self { conn, root })
        }
    }

    impl PointerProbe for X11Probe {
        fn location(&mut self) -> Option<(f64, f64)> {
            let reply = self.conn.query_pointer(self.root).ok()?.reply().ok()?;
            Some((f64::from(reply.root_x), f64::from(reply.root_y)))
        }

        fn button(&mut self) -> ButtonSample {
            let held = self
                .conn
                .query_pointer(self.root)
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| r.mask.contains(KeyButMask::BUTTON1))
                .unwrap_or(false);
            // X11 exposes no event counter without XInput2 event selection;
            // taps shorter than one tick stay best-effort here.
            ButtonSample {
                held,
                missed_taps: 0,
            }
        }

        // X11 exposes no portable named-cursor query; shapes stay `Default`
        // and the editor draws the user's chosen arrow style.
        fn shape(&mut self) -> CursorShape {
            CursorShape::Default
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    #[test]
    fn dropping_the_tracker_stops_the_sampler() {
        let tracker = CursorTracker::start(
            CaptureRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            1.0,
            Instant::now(),
        );
        let flag = tracker.stop_flag();
        assert!(!flag.load(Ordering::Relaxed));
        drop(tracker);
        assert!(
            flag.load(Ordering::Relaxed),
            "Drop must set the sampler stop flag"
        );
    }

    #[test]
    fn shape_debouncer_suppresses_single_probe_blips() {
        let mut d = ShapeDebouncer::new();
        // One 10 Hz probe glitch spans 6 ticks at the mac cadence — must
        // never reach the track.
        for _ in 0..6 {
            assert_eq!(d.feed(CursorShape::Pointer), CursorShape::Default);
        }
        assert_eq!(d.feed(CursorShape::Default), CursorShape::Default);
    }

    #[test]
    fn shape_debouncer_settles_sustained_changes() {
        let mut d = ShapeDebouncer::new();
        let mut settled = CursorShape::Default;
        for _ in 0..=SHAPE_STABLE_TICKS {
            settled = d.feed(CursorShape::Text);
        }
        assert_eq!(settled, CursorShape::Text);
        // And returning to default also requires confirmation.
        assert_eq!(d.feed(CursorShape::Default), CursorShape::Text);
    }

    #[test]
    fn shape_debouncer_restarts_streak_on_flapping() {
        let mut d = ShapeDebouncer::new();
        // Alternating probes never settle anywhere but the original shape.
        for _ in 0..20 {
            assert_eq!(d.feed(CursorShape::Grab), CursorShape::Default);
            assert_eq!(d.feed(CursorShape::Grabbing), CursorShape::Default);
        }
    }

    #[cfg(all(target_os = "linux", feature = "portal-capture"))]
    #[test]
    fn portal_cursor_feed_publish_clear() {
        let feed = PortalCursorFeed::new();
        assert!(feed.peek().is_none());
        feed.publish(10.0, 20.0);
        assert_eq!(feed.peek(), Some((10.0, 20.0)));
        feed.clear();
        assert!(feed.peek().is_none());
    }
}
