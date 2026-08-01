//! iPhone / iPad screen capture over USB — CoreMediaIO + AVFoundation (macOS).
//!
//! **This is not ScreenCaptureKit and not a "window".** A connected iOS device is
//! published by CoreMediaIO as an *external capture device* — the same class of
//! object as a webcam — that streams the phone's own display. AVFoundation hides
//! those devices from every process until one opts in via
//! `kCMIOHardwarePropertyAllowScreenCaptureDevices`; that single property is why
//! QuickTime can list your iPhone and nothing else can. [`enable_screen_devices`]
//! is the whole trick, and it must run before the first enumeration.
//!
//! Consequences that shape this backend, versus the screen backends:
//!   * frame size, frame rate and orientation belong to the *device*, so
//!     [`CaptureHandle`] dimensions are learned from the first frame rather than
//!     asked for up front (rotating the phone mid-recording is therefore not
//!     supported — the encoder is opened at a fixed size);
//!   * there is no window list, no crop, and no cursor to record;
//!   * audio is the phone's own audio, carried on the same *muxed* device, so
//!     `capture_system_audio` maps to an `AVCaptureAudioDataOutput` here.
//!
//! Threading mirrors [`super::scap_backend`]: none of these Objective-C objects
//! are `Send`, so the session is built and torn down entirely inside the producer
//! thread. Frames arrive on a libdispatch queue owned by AVFoundation and are
//! handed to the encoder over the same bounded channel every other backend uses.

#![allow(non_upper_case_globals, non_snake_case)]

use super::{
    CaptureBackend, CaptureHandle, RawAudio, RawFrame, AUDIO_CHANNEL_CAP, CAPTURE_CHANNEL_CAP,
};
use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_RATE};
use crate::recorder::types::{CaptureDevice, CaptureSource, RecorderConfig};
use crossbeam_channel::Sender;
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
use objc::{class, msg_send, sel, sel_impl};
use parking_lot::Mutex;
use std::ffi::{c_void, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// `device:` ids round-trip through [`RecorderConfig::source_id`]; this prefix is
/// what routes a start request here instead of to ScreenCaptureKit.
pub const DEVICE_ID_PREFIX: &str = "device:";

/// How long `start` waits for the phone to deliver its first frame. Waking a
/// locked device and negotiating the USB video session is genuinely slow the
/// first time (the phone shows a "Trust" prompt on a fresh cable).
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(12);

// ---------------------------------------------------------------------------
// Core Foundation / CoreMedia / CoreVideo / CoreMediaIO FFI
// ---------------------------------------------------------------------------

type CMSampleBufferRef = *mut c_void;
type CVImageBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

impl CMTime {
    /// Seconds, or `None` when the timestamp is invalid (`kCMTimeInvalid` has a
    /// zero timescale, which would divide by zero).
    fn seconds(self) -> Option<f64> {
        if self.timescale == 0 {
            return None;
        }
        Some(self.value as f64 / self.timescale as f64)
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CMVideoDimensions {
    width: i32,
    height: i32,
}

#[repr(C)]
struct CMIOObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

/// One-buffer `AudioBufferList`. We force interleaved PCM in `audioSettings`, so
/// AVFoundation always hands back exactly one buffer.
#[repr(C)]
struct AudioBufferList1 {
    number_buffers: u32,
    buffers: [AudioBuffer; 1],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

/// FourCC literal, e.g. `fourcc(b"yes ")`.
const fn fourcc(code: &[u8; 4]) -> u32 {
    ((code[0] as u32) << 24) | ((code[1] as u32) << 16) | ((code[2] as u32) << 8) | code[3] as u32
}

const kCMIOObjectSystemObject: u32 = 1;
const kCMIOObjectPropertyScopeGlobal: u32 = fourcc(b"glob");
const kCMIOObjectPropertyElementMain: u32 = 0;
/// The opt-in that makes wired iOS screen devices visible to AVFoundation.
const kCMIOHardwarePropertyAllowScreenCaptureDevices: u32 = fourcc(b"yes ");
/// Same, for devices offered over the network (AirPlay-style QuickTime capture).
const kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices: u32 = fourcc(b"wisc");

const kCVPixelFormatType_32BGRA: u32 = fourcc(b"BGRA");
const kCVPixelBufferLock_ReadOnly: u64 = 0x0000_0001;

const kAudioFormatLinearPCM: u32 = fourcc(b"lpcm");

/// `AVCaptureDevicePositionUnspecified`.
const AVCaptureDevicePositionUnspecified: i64 = 0;

/// `AVAuthorizationStatus`.
const AVAuthorizationStatusAuthorized: i64 = 3;

#[link(name = "CoreMediaIO", kind = "framework")]
extern "C" {
    fn CMIOObjectSetPropertyData(
        objectID: u32,
        address: *const CMIOObjectPropertyAddress,
        qualifierDataSize: u32,
        qualifierData: *const c_void,
        dataSize: u32,
        data: *const c_void,
    ) -> i32;
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetImageBuffer(sbuf: CMSampleBufferRef) -> CVImageBufferRef;
    fn CMSampleBufferGetPresentationTimeStamp(sbuf: CMSampleBufferRef) -> CMTime;
    fn CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sbuf: CMSampleBufferRef,
        bufferListSizeNeededOut: *mut usize,
        bufferListOut: *mut AudioBufferList1,
        bufferListSize: usize,
        blockBufferStructureAllocator: *const c_void,
        blockBufferBlockAllocator: *const c_void,
        flags: u32,
        blockBufferOut: *mut CMBlockBufferRef,
    ) -> i32;
    fn CMVideoFormatDescriptionGetDimensions(desc: CMFormatDescriptionRef) -> CMVideoDimensions;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferLockBaseAddress(pb: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(pb: CVImageBufferRef) -> *mut c_void;
    fn CVPixelBufferGetWidth(pb: CVImageBufferRef) -> usize;
    fn CVPixelBufferGetHeight(pb: CVImageBufferRef) -> usize;
    fn CVPixelBufferGetBytesPerRow(pb: CVImageBufferRef) -> usize;
    static kCVPixelBufferPixelFormatTypeKey: *const Object;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

// Linking AVFoundation is what registers `AVCaptureSession` & friends with the
// Objective-C runtime, so `class!()` below can find them.
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVMediaTypeVideo: *const Object;
    static AVMediaTypeMuxed: *const Object;

    static AVFormatIDKey: *const Object;
    static AVSampleRateKey: *const Object;
    static AVNumberOfChannelsKey: *const Object;
    static AVLinearPCMBitDepthKey: *const Object;
    static AVLinearPCMIsFloatKey: *const Object;
    static AVLinearPCMIsBigEndianKey: *const Object;
    static AVLinearPCMIsNonInterleaved: *const Object;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut Object;
    /// Function-pointer form of `dispatch_sync`. Used as a teardown barrier —
    /// the block form would pull in an Objective-C block runtime for no reason.
    fn dispatch_sync_f(queue: *mut Object, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

/// No-op body for the [`dispatch_sync_f`] drain barrier.
extern "C" fn noop_barrier(_: *mut c_void) {}

/// `RTLD_DEFAULT` — search every loaded image.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

// ---------------------------------------------------------------------------
// Objective-C helpers
// ---------------------------------------------------------------------------

/// Rust `String` from an autoreleased `NSString` (borrowed — we do not release).
unsafe fn rust_string(ns: *mut Object) -> Option<String> {
    if ns.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![ns, UTF8String];
    if utf8.is_null() {
        return None;
    }
    std::ffi::CStr::from_ptr(utf8)
        .to_str()
        .ok()
        .map(str::to_owned)
}

unsafe fn nsnumber_u32(v: u32) -> *mut Object {
    msg_send![class!(NSNumber), numberWithUnsignedInt: v]
}

unsafe fn nsnumber_i32(v: i32) -> *mut Object {
    msg_send![class!(NSNumber), numberWithInt: v]
}

unsafe fn nsnumber_bool(v: bool) -> *mut Object {
    let b: BOOL = if v { YES } else { NO };
    msg_send![class!(NSNumber), numberWithBool: b]
}

/// Autoreleased `NSDictionary` from parallel key/value slices.
unsafe fn nsdictionary(keys: &[*const Object], values: &[*mut Object]) -> *mut Object {
    debug_assert_eq!(keys.len(), values.len());
    msg_send![class!(NSDictionary),
        dictionaryWithObjects: values.as_ptr()
                     forKeys: keys.as_ptr()
                       count: keys.len()]
}

/// Autoreleased `NSArray` of the given objects.
unsafe fn nsarray(items: &[*mut Object]) -> *mut Object {
    msg_send![class!(NSArray), arrayWithObjects: items.as_ptr() count: items.len()]
}

/// An `NSString *const` exported by a framework, resolved at runtime so that
/// referencing a constant added in a newer macOS can't break loading on an older
/// one (`AVCaptureDeviceTypeExternal` is macOS 14+).
unsafe fn dynamic_nsstring_const(symbol: &str) -> Option<*mut Object> {
    let name = CString::new(symbol).ok()?;
    let addr = dlsym(RTLD_DEFAULT, name.as_ptr());
    if addr.is_null() {
        return None;
    }
    let value = *(addr as *const *mut Object);
    if value.is_null() {
        None
    } else {
        Some(value)
    }
}

/// Scoped `NSAutoreleasePool` — AVFoundation's accessors return autoreleased
/// objects, and enumeration runs off the main thread where no pool exists.
struct AutoreleasePool(*mut Object);

impl AutoreleasePool {
    unsafe fn new() -> Self {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        Self(pool)
    }
}

impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.0, drain];
        }
    }
}

// ---------------------------------------------------------------------------
// CoreMediaIO opt-in
// ---------------------------------------------------------------------------

/// Publish wired (and wireless) iOS screen-capture devices to AVFoundation.
///
/// Idempotent and cheap, but it must happen **before** the first
/// `AVCaptureDevice` query in this process or the device list comes back without
/// the phone. Everything public in this module funnels through here first.
fn enable_screen_devices() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        for selector in [
            kCMIOHardwarePropertyAllowScreenCaptureDevices,
            kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices,
        ] {
            let address = CMIOObjectPropertyAddress {
                selector,
                scope: kCMIOObjectPropertyScopeGlobal,
                element: kCMIOObjectPropertyElementMain,
            };
            let allow: u32 = 1;
            let status = unsafe {
                CMIOObjectSetPropertyData(
                    kCMIOObjectSystemObject,
                    &address,
                    0,
                    std::ptr::null(),
                    std::mem::size_of::<u32>() as u32,
                    &allow as *const u32 as *const c_void,
                )
            };
            if status != 0 {
                tracing::warn!(status, selector, "CMIO screen-device opt-in failed");
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/// Whether the user has granted Camera access — iOS screen devices live behind
/// the *camera* TCC prompt, not the screen-recording one.
fn camera_authorized() -> bool {
    unsafe {
        let _pool = AutoreleasePool::new();
        let status: i64 =
            msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: AVMediaTypeVideo];
        status == AVAuthorizationStatusAuthorized
    }
}

/// Every `AVCaptureDevice` that could plausibly be an iOS screen source.
///
/// Two overlapping queries, because Apple has moved this API twice: a discovery
/// session over the external device types (the supported path, but the type
/// constants differ per OS version) and the deprecated `devicesWithMediaType:`
/// for muxed devices (still the most reliable way to see a wired iPhone).
/// Deduped by `uniqueID`.
unsafe fn candidate_devices() -> Vec<*mut Object> {
    let mut out: Vec<*mut Object> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let push_all = |array: *mut Object, out: &mut Vec<*mut Object>, seen: &mut Vec<String>| {
        if array.is_null() {
            return;
        }
        let count: usize = msg_send![array, count];
        for i in 0..count {
            let device: *mut Object = msg_send![array, objectAtIndex: i];
            if device.is_null() {
                continue;
            }
            let uid: *mut Object = msg_send![device, uniqueID];
            let Some(uid) = rust_string(uid) else { continue };
            if seen.contains(&uid) {
                continue;
            }
            seen.push(uid);
            out.push(device);
        }
    };

    // Path 1 — AVCaptureDeviceDiscoverySession over whichever external device
    // types this macOS knows about. `AVCaptureDeviceTypeExternal` is macOS 14+;
    // `…ExternalUnknown` is the 10.15–13 spelling. Resolve both dynamically.
    let types: Vec<*mut Object> = ["AVCaptureDeviceTypeExternal", "AVCaptureDeviceTypeExternalUnknown"]
        .into_iter()
        .filter_map(|s| dynamic_nsstring_const(s))
        .collect();
    if !types.is_empty() {
        let type_array = nsarray(&types);
        // A nil mediaType returns devices of *any* media type among those
        // device types — which is what catches muxed iOS screen devices.
        let session: *mut Object = msg_send![class!(AVCaptureDeviceDiscoverySession),
            discoverySessionWithDeviceTypes: type_array
                                  mediaType: std::ptr::null::<Object>()
                                   position: AVCaptureDevicePositionUnspecified];
        if !session.is_null() {
            let devices: *mut Object = msg_send![session, devices];
            push_all(devices, &mut out, &mut seen);
        }
    }

    // Path 2 — the deprecated muxed query. Still the surest way to see a wired
    // iPhone, and harmless when it returns nothing.
    let muxed: *mut Object =
        msg_send![class!(AVCaptureDevice), devicesWithMediaType: AVMediaTypeMuxed];
    push_all(muxed, &mut out, &mut seen);

    out
}

/// Is this device an iOS screen source rather than, say, a USB webcam?
///
/// CoreMediaIO reports `modelID == "iOS Device"` for them, which is the precise
/// signal; carrying muxed media (video *and* audio on one device) is the
/// structural fallback, since webcams publish video only.
unsafe fn is_ios_screen_device(device: *mut Object) -> bool {
    let model: *mut Object = msg_send![device, modelID];
    if let Some(model) = rust_string(model) {
        if model.contains("iOS Device") {
            return true;
        }
    }
    let muxed: BOOL = msg_send![device, hasMediaType: AVMediaTypeMuxed];
    muxed == YES
}

/// Native pixel size of the device's active format, best-effort. Reports `0` when
/// the phone hasn't negotiated a format yet (it does that on first connect).
unsafe fn active_dimensions(device: *mut Object) -> (u32, u32) {
    let format: *mut Object = msg_send![device, activeFormat];
    if format.is_null() {
        return (0, 0);
    }
    let desc: CMFormatDescriptionRef = msg_send![format, formatDescription];
    if desc.is_null() {
        return (0, 0);
    }
    let dims = CMVideoFormatDescriptionGetDimensions(desc);
    (dims.width.max(0) as u32, dims.height.max(0) as u32)
}

/// Connected iPhones / iPads, ready for the recorder's Device menu.
pub fn list_devices() -> AppResult<Vec<CaptureDevice>> {
    enable_screen_devices();

    let devices = unsafe {
        let _pool = AutoreleasePool::new();
        let mut out = Vec::new();
        for device in candidate_devices() {
            if !is_ios_screen_device(device) {
                continue;
            }
            let connected: BOOL = msg_send![device, isConnected];
            if connected != YES {
                continue;
            }
            let uid: *mut Object = msg_send![device, uniqueID];
            let Some(uid) = rust_string(uid) else { continue };
            let name: *mut Object = msg_send![device, localizedName];
            let name = rust_string(name).unwrap_or_else(|| "iOS device".to_string());
            let model: *mut Object = msg_send![device, modelID];
            let (width, height) = active_dimensions(device);
            let has_audio: BOOL = msg_send![device, hasMediaType: AVMediaTypeMuxed];

            out.push(CaptureDevice {
                id: format!("{DEVICE_ID_PREFIX}{uid}"),
                name,
                model: rust_string(model),
                width,
                height,
                has_audio: has_audio == YES,
            });
        }
        out
    };

    // Camera TCC gates the *stream*, not enumeration — surface an actionable
    // error only when there is genuinely nothing we could do with a device.
    if devices.is_empty() && !camera_authorized() {
        return Err(AppError::PermissionDenied);
    }
    Ok(devices)
}

/// Look up a live `AVCaptureDevice` by the `uniqueID` embedded in a `device:` id.
///
/// Returns a **borrowed** (autoreleased) pointer — callers must retain it before
/// leaving the enclosing autorelease pool.
unsafe fn find_device(unique_id: &str) -> Option<*mut Object> {
    for device in candidate_devices() {
        let uid: *mut Object = msg_send![device, uniqueID];
        if rust_string(uid).as_deref() == Some(unique_id) {
            return Some(device);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Sample-buffer delegate
// ---------------------------------------------------------------------------

/// Shared state the Objective-C delegate writes into. Held by an `Arc` that the
/// producer thread keeps alive for exactly as long as the session is running;
/// the delegate object stores a borrowed pointer to it in an ivar.
struct DelegateCtx {
    /// `None` once the producer has torn down — closes the channel so the encode
    /// loop finishes instead of blocking forever on a dead phone.
    frames: Mutex<Option<Sender<RawFrame>>>,
    audio: Mutex<Option<Sender<RawAudio>>>,
    /// Presentation time of the first video frame, in seconds on the device's
    /// clock. Frame timestamps are reported relative to it, matching the other
    /// backends' "capture clock, not wall clock" contract.
    epoch: Mutex<Option<f64>>,
    /// Resolved once, from the first frame, to size the encoder.
    dims: Mutex<Option<(u32, u32)>>,
    dims_ready: Sender<(u32, u32)>,
    dropped: Arc<AtomicU64>,
}

const CTX_IVAR: &str = "capptivoCtx";

/// The runtime-declared delegate class. Registered once per process; registering
/// the same name twice would abort.
fn delegate_class() -> &'static Class {
    static CLASS: OnceLock<usize> = OnceLock::new();
    let ptr = *CLASS.get_or_init(|| {
        let superclass = class!(NSObject);
        let mut decl = ClassDecl::new("CapptivoAVFSampleDelegate", superclass)
            .expect("CapptivoAVFSampleDelegate already registered");
        decl.add_ivar::<*mut c_void>(CTX_IVAR);
        unsafe {
            decl.add_method(
                sel!(captureOutput:didOutputSampleBuffer:fromConnection:),
                did_output_sample_buffer
                    as extern "C" fn(&mut Object, Sel, *mut Object, CMSampleBufferRef, *mut Object),
            );
            decl.add_method(
                sel!(captureOutput:didDropSampleBuffer:fromConnection:),
                did_drop_sample_buffer
                    as extern "C" fn(&mut Object, Sel, *mut Object, CMSampleBufferRef, *mut Object),
            );
        }
        decl.register() as *const Class as usize
    });
    unsafe { &*(ptr as *const Class) }
}

/// Borrow the context out of the delegate's ivar. Safe because the producer
/// thread outlives every callback: it clears the outputs' delegates and stops the
/// session before dropping its `Arc`.
unsafe fn ctx_of(this: &Object) -> Option<&DelegateCtx> {
    let ptr: *mut c_void = *this.get_ivar(CTX_IVAR);
    if ptr.is_null() {
        None
    } else {
        Some(&*(ptr as *const DelegateCtx))
    }
}

extern "C" fn did_output_sample_buffer(
    this: &mut Object,
    _cmd: Sel,
    _output: *mut Object,
    sample: CMSampleBufferRef,
    _connection: *mut Object,
) {
    unsafe {
        let Some(ctx) = ctx_of(this) else { return };
        // A video sample carries an image buffer; an audio sample does not. That
        // is a cheaper and more robust discriminator than comparing output
        // pointers, and it cannot go stale if outputs are reordered.
        let image = CMSampleBufferGetImageBuffer(sample);
        if image.is_null() {
            handle_audio(ctx, sample);
        } else {
            handle_video(ctx, sample, image);
        }
    }
}

extern "C" fn did_drop_sample_buffer(
    this: &mut Object,
    _cmd: Sel,
    _output: *mut Object,
    _sample: CMSampleBufferRef,
    _connection: *mut Object,
) {
    unsafe {
        if let Some(ctx) = ctx_of(this) {
            ctx.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

unsafe fn handle_video(ctx: &DelegateCtx, sample: CMSampleBufferRef, image: CVImageBufferRef) {
    if CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly) != 0 {
        return;
    }
    let base = CVPixelBufferGetBaseAddress(image);
    let width = CVPixelBufferGetWidth(image) as u32;
    let height = CVPixelBufferGetHeight(image) as u32;
    let bytes_per_row = CVPixelBufferGetBytesPerRow(image);

    let data = if base.is_null() || width == 0 || height == 0 {
        None
    } else {
        // One memcpy of the whole plane, padding included — the encoder honors
        // `bytes_per_row`, so repacking rows here would be pure overhead.
        let len = bytes_per_row * height as usize;
        let mut buf = Vec::<u8>::with_capacity(len);
        std::ptr::copy_nonoverlapping(base as *const u8, buf.as_mut_ptr(), len);
        buf.set_len(len);
        Some(buf)
    };
    CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);

    let Some(data) = data else { return };

    // Timestamps ride the device's clock, rebased so the first frame is t=0.
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds();
    let timestamp = match pts {
        Some(pts) => {
            let mut epoch = ctx.epoch.lock();
            let start = *epoch.get_or_insert(pts);
            Duration::from_secs_f64((pts - start).max(0.0))
        }
        None => Duration::ZERO,
    };

    // First frame decides the encoder's dimensions. A later size change (the user
    // rotated the phone) can't be honored mid-stream, so those frames are dropped
    // rather than fed to an encoder expecting a different geometry.
    {
        let mut dims = ctx.dims.lock();
        match *dims {
            None => {
                *dims = Some((width, height));
                let _ = ctx.dims_ready.try_send((width, height));
            }
            Some((w, h)) if w != width || h != height => {
                ctx.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            Some(_) => {}
        }
    }

    let guard = ctx.frames.lock();
    let Some(tx) = guard.as_ref() else { return };
    let frame = RawFrame {
        width,
        height,
        bytes_per_row: bytes_per_row as u32,
        data,
        timestamp,
    };
    // Same back-pressure policy as every other backend: drop and count rather
    // than grow memory when the encoder falls behind.
    if tx.try_send(frame).is_err() {
        ctx.dropped.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe fn handle_audio(ctx: &DelegateCtx, sample: CMSampleBufferRef) {
    let guard = ctx.audio.lock();
    let Some(tx) = guard.as_ref() else { return };

    let mut list = AudioBufferList1 {
        number_buffers: 0,
        buffers: [AudioBuffer {
            number_channels: 0,
            data_byte_size: 0,
            data: std::ptr::null_mut(),
        }],
    };
    let mut block: CMBlockBufferRef = std::ptr::null_mut();
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample,
        std::ptr::null_mut(),
        &mut list,
        std::mem::size_of::<AudioBufferList1>(),
        std::ptr::null(),
        std::ptr::null(),
        0,
        &mut block,
    );
    if status != 0 {
        if !block.is_null() {
            CFRelease(block);
        }
        return;
    }

    // `audioSettings` pins the output to interleaved 32-bit float at the
    // encoder's rate, so this is always a single buffer needing no conversion.
    let buffer = list.buffers[0];
    if list.number_buffers >= 1 && !buffer.data.is_null() && buffer.data_byte_size > 0 {
        let len = buffer.data_byte_size as usize;
        let mut data = Vec::<u8>::with_capacity(len);
        std::ptr::copy_nonoverlapping(buffer.data as *const u8, data.as_mut_ptr(), len);
        data.set_len(len);
        let _ = tx.try_send(RawAudio {
            data,
            sample_rate: SYSTEM_AUDIO_RATE,
            channels: SYSTEM_AUDIO_CHANNELS,
        });
    }

    // The "RetainedBlockBuffer" in the name: this reference is ours to release,
    // and leaking it would pin every audio packet's backing store for the whole
    // recording.
    if !block.is_null() {
        CFRelease(block);
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// Every Objective-C object the running session owns, so teardown is one place
/// and can't half-release. Built and dropped on the producer thread only.
struct Session {
    session: *mut Object,
    video_output: *mut Object,
    audio_output: *mut Object,
    delegate: *mut Object,
    queue: *mut Object,
    device: *mut Object,
}

impl Session {
    /// Stop the stream and release everything.
    ///
    /// The order matters and is the difference between a clean stop and a
    /// use-after-free on the delegate context:
    ///   1. `stopRunning` — synchronous, so no *new* buffers are produced after
    ///      it returns;
    ///   2. detach the delegates, so nothing new is enqueued;
    ///   3. drain the callback queue with a barrier — a buffer dispatched just
    ///      before step 1 may still be mid-flight, and it borrows the context
    ///      that the caller drops the moment this returns;
    ///   4. only then release the Objective-C objects.
    unsafe fn teardown(&mut self) {
        if !self.session.is_null() {
            let running: BOOL = msg_send![self.session, isRunning];
            if running == YES {
                let _: () = msg_send![self.session, stopRunning];
            }
        }
        if !self.video_output.is_null() {
            let _: () = msg_send![self.video_output, setSampleBufferDelegate: std::ptr::null::<Object>()
                                                                       queue: std::ptr::null::<Object>()];
        }
        if !self.audio_output.is_null() {
            let _: () = msg_send![self.audio_output, setSampleBufferDelegate: std::ptr::null::<Object>()
                                                                       queue: std::ptr::null::<Object>()];
        }
        if !self.queue.is_null() {
            // Serial queue: once this empty job has run, every callback queued
            // ahead of it has already returned.
            dispatch_sync_f(self.queue, std::ptr::null_mut(), noop_barrier);
        }
        if !self.session.is_null() {
            let _: () = msg_send![self.session, release];
            self.session = std::ptr::null_mut();
        }
        for obj in [
            &mut self.video_output,
            &mut self.audio_output,
            &mut self.delegate,
            &mut self.queue,
            &mut self.device,
        ] {
            if !obj.is_null() {
                let _: () = msg_send![*obj, release];
                *obj = std::ptr::null_mut();
            }
        }
    }
}

/// Build and start an `AVCaptureSession` streaming the given device.
///
/// `ctx` must outlive the returned [`Session`] — the delegate holds a borrowed
/// pointer to it.
unsafe fn build_session(
    unique_id: &str,
    want_audio: bool,
    ctx: &Arc<DelegateCtx>,
) -> AppResult<Session> {
    let device = find_device(unique_id)
        .ok_or_else(|| AppError::InvalidSource(format!("{DEVICE_ID_PREFIX}{unique_id}")))?;
    let _: *mut Object = msg_send![device, retain];

    let mut built = Session {
        session: std::ptr::null_mut(),
        video_output: std::ptr::null_mut(),
        audio_output: std::ptr::null_mut(),
        delegate: std::ptr::null_mut(),
        queue: std::ptr::null_mut(),
        device,
    };

    let session: *mut Object = msg_send![class!(AVCaptureSession), new];
    if session.is_null() {
        built.teardown();
        return Err(AppError::Other("failed to create AVCaptureSession".into()));
    }
    built.session = session;

    // Never set a sessionPreset: presets resample to a fixed size, and we want
    // the phone's native screen resolution passed through untouched.
    let _: () = msg_send![session, beginConfiguration];

    let mut error: *mut Object = std::ptr::null_mut();
    let input: *mut Object = msg_send![class!(AVCaptureDeviceInput),
        deviceInputWithDevice: device
                        error: &mut error];
    if input.is_null() {
        let message = if error.is_null() {
            "could not open the device".to_string()
        } else {
            let desc: *mut Object = msg_send![error, localizedDescription];
            rust_string(desc).unwrap_or_else(|| "could not open the device".into())
        };
        let _: () = msg_send![session, commitConfiguration];
        built.teardown();
        return Err(AppError::Other(format!("device capture: {message}")));
    }
    let can_add: BOOL = msg_send![session, canAddInput: input];
    if can_add != YES {
        let _: () = msg_send![session, commitConfiguration];
        built.teardown();
        return Err(AppError::Other(
            "device capture: the session rejected this device".into(),
        ));
    }
    let _: () = msg_send![session, addInput: input];

    // One serial queue for both outputs, so video and audio callbacks can't
    // interleave and fight over the context locks.
    let label = CString::new("com.capptivo.avf-device").unwrap();
    let queue = dispatch_queue_create(label.as_ptr(), std::ptr::null());
    built.queue = queue;

    let delegate: *mut Object = msg_send![delegate_class(), new];
    (*delegate).set_ivar(CTX_IVAR, Arc::as_ptr(ctx) as *mut c_void);
    built.delegate = delegate;

    // --- video ---
    let video_output: *mut Object = msg_send![class!(AVCaptureVideoDataOutput), new];
    built.video_output = video_output;
    let pixel_format = nsnumber_u32(kCVPixelFormatType_32BGRA);
    let video_settings = nsdictionary(&[kCVPixelBufferPixelFormatTypeKey], &[pixel_format]);
    let _: () = msg_send![video_output, setVideoSettings: video_settings];
    // Let AVFoundation drop stale frames instead of queueing them: a late frame
    // is worthless to a recorder and queueing them only inflates latency.
    let _: () = msg_send![video_output, setAlwaysDiscardsLateVideoFrames: YES];
    let _: () = msg_send![video_output, setSampleBufferDelegate: delegate queue: queue];
    let can_add: BOOL = msg_send![session, canAddOutput: video_output];
    if can_add != YES {
        let _: () = msg_send![session, commitConfiguration];
        built.teardown();
        return Err(AppError::Other(
            "device capture: no video output available".into(),
        ));
    }
    let _: () = msg_send![session, addOutput: video_output];

    // --- audio (the phone's own output, carried on the muxed device) ---
    if want_audio {
        let audio_output: *mut Object = msg_send![class!(AVCaptureAudioDataOutput), new];
        built.audio_output = audio_output;
        // Pin the format so AVFoundation does the conversion and the delegate
        // can hand the encoder interleaved f32le without touching a resampler.
        let settings = nsdictionary(
            &[
                AVFormatIDKey,
                AVSampleRateKey,
                AVNumberOfChannelsKey,
                AVLinearPCMBitDepthKey,
                AVLinearPCMIsFloatKey,
                AVLinearPCMIsBigEndianKey,
                AVLinearPCMIsNonInterleaved,
            ],
            &[
                nsnumber_u32(kAudioFormatLinearPCM),
                nsnumber_i32(SYSTEM_AUDIO_RATE as i32),
                nsnumber_i32(SYSTEM_AUDIO_CHANNELS as i32),
                nsnumber_i32(32),
                nsnumber_bool(true),
                nsnumber_bool(false),
                nsnumber_bool(false),
            ],
        );
        let _: () = msg_send![audio_output, setAudioSettings: settings];
        let _: () = msg_send![audio_output, setSampleBufferDelegate: delegate queue: queue];
        let can_add: BOOL = msg_send![session, canAddOutput: audio_output];
        if can_add == YES {
            let _: () = msg_send![session, addOutput: audio_output];
        } else {
            // Not fatal — an iPad without an audio stream should still record
            // video rather than refusing to start.
            tracing::warn!("device capture: no audio output available; recording video only");
            let _: () = msg_send![audio_output, setSampleBufferDelegate: std::ptr::null::<Object>()
                                                                 queue: std::ptr::null::<Object>()];
            let _: () = msg_send![audio_output, release];
            built.audio_output = std::ptr::null_mut();
        }
    }

    let _: () = msg_send![session, commitConfiguration];
    let _: () = msg_send![session, startRunning];

    Ok(built)
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/// Capture backend for wired iOS devices. Handles only `device:` source ids —
/// see [`super::router::RoutingBackend`] for how requests get here.
pub struct AvfDeviceBackend;

impl AvfDeviceBackend {
    pub fn new() -> Self {
        enable_screen_devices();
        Self
    }
}

impl Default for AvfDeviceBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl CaptureBackend for AvfDeviceBackend {
    fn is_supported(&self) -> bool {
        true
    }

    /// Camera TCC — iOS screen devices are camera-class devices, so they are
    /// gated by `NSCameraUsageDescription`, not screen recording.
    fn has_permission(&self) -> bool {
        camera_authorized()
    }

    /// Starting the session is itself what raises the camera prompt, so there is
    /// nothing separate to request here.
    fn request_permission(&self) -> bool {
        camera_authorized()
    }

    /// Devices are not displays or windows — they are listed through
    /// [`list_devices`] and never appear in the screen picker.
    fn list_sources(&self, _include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        Ok(Vec::new())
    }

    fn list_devices(&self) -> AppResult<Vec<CaptureDevice>> {
        list_devices()
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        enable_screen_devices();

        let unique_id = config
            .source_id
            .strip_prefix(DEVICE_ID_PREFIX)
            .ok_or_else(|| AppError::InvalidSource(config.source_id.clone()))?
            .to_string();
        if unique_id.is_empty() {
            return Err(AppError::InvalidSource(config.source_id.clone()));
        }

        let want_audio = config.capture_system_audio;
        let (frame_tx, frame_rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let (audio_tx, audio_rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let (dims_tx, dims_rx) = crossbeam_channel::bounded::<(u32, u32)>(1);
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<AppResult<()>>(1);

        let dropped = Arc::new(AtomicU64::new(0));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let ctx = Arc::new(DelegateCtx {
            frames: Mutex::new(Some(frame_tx)),
            audio: Mutex::new(want_audio.then_some(audio_tx)),
            epoch: Mutex::new(None),
            dims: Mutex::new(None),
            dims_ready: dims_tx,
            dropped: dropped.clone(),
        });

        // AVFoundation objects are not `Send`, so — exactly as in the scap
        // backend — the session is created, owned and destroyed on one thread.
        let thread_stop = stop_flag.clone();
        let thread_ctx = ctx.clone();
        std::thread::Builder::new()
            .name("avf-device-capture".into())
            .spawn(move || {
                let _pool = unsafe { AutoreleasePool::new() };
                let mut session = match unsafe { build_session(&unique_id, want_audio, &thread_ctx) }
                {
                    Ok(session) => {
                        let _ = ready_tx.send(Ok(()));
                        session
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };

                // Idle until stopped, but notice a yanked cable: without this the
                // encode loop would block forever on a channel nothing will ever
                // write to again.
                while !thread_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    let alive: BOOL = unsafe { msg_send![session.device, isConnected] };
                    if alive != YES {
                        tracing::warn!("device disconnected during recording");
                        break;
                    }
                }

                unsafe { session.teardown() };
                // Closing the senders ends the encode loop cleanly. Must happen
                // after teardown, so no callback can resurrect a send.
                *thread_ctx.frames.lock() = None;
                *thread_ctx.audio.lock() = None;
            })
            .map_err(|e| AppError::Other(format!("failed to spawn device capture thread: {e}")))?;

        // Surface setup failures (bad id, denied camera, device busy) as errors
        // from `start`, before the recorder commits to a project directory.
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                return Err(AppError::Other(
                    "device capture: timed out opening the device".into(),
                ));
            }
        }

        // The encoder is opened at a fixed size, so we must know the phone's
        // resolution before returning — only the first frame can tell us.
        let (width, height) = match dims_rx.recv_timeout(FIRST_FRAME_TIMEOUT) {
            Ok(dims) => dims,
            Err(_) => {
                stop_flag.store(true, Ordering::Relaxed);
                return Err(AppError::Other(
                    "device capture: no frames from the device — unlock it and confirm \
                     the “Trust This Computer” prompt, then try again"
                        .into(),
                ));
            }
        };

        let fps = config.fps.clamp(1, 120);
        let stop_signal = stop_flag.clone();
        let mut handle = CaptureHandle::new(width, height, fps, frame_rx, dropped, move || {
            stop_signal.store(true, Ordering::Relaxed);
        });
        // No pointer to record and no display to normalize against: the phone's
        // frame *is* the capture rect, at its own native scale.
        handle.tracks_cursor = false;
        handle.scale_factor = 1.0;
        if want_audio {
            handle.audio = Some(audio_rx);
        }
        Ok(handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_matches_apple_constants() {
        // 'yes ' / 'glob' as CoreMediaIO spells them.
        assert_eq!(kCMIOHardwarePropertyAllowScreenCaptureDevices, 0x7965_7320);
        assert_eq!(kCMIOObjectPropertyScopeGlobal, 0x676c_6f62);
        assert_eq!(kCVPixelFormatType_32BGRA, 0x4247_5241);
        assert_eq!(kAudioFormatLinearPCM, 0x6c70_636d);
    }

    #[test]
    fn cmtime_guards_zero_timescale() {
        let invalid = CMTime {
            value: 1,
            timescale: 0,
            flags: 0,
            epoch: 0,
        };
        assert!(invalid.seconds().is_none());
        let valid = CMTime {
            value: 3000,
            timescale: 1000,
            flags: 1,
            epoch: 0,
        };
        assert_eq!(valid.seconds(), Some(3.0));
    }

    /// Enumeration must be safe to call with no device attached, no camera
    /// permission, and off the main thread.
    #[test]
    fn listing_devices_does_not_panic() {
        let _ = list_devices();
    }
}
