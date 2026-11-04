//! Windows typing activity + focused-field geometry. Never read text or key values.
//! Accessibility calls run off the cursor sampler: a slow provider cannot stall video.
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, UIA_EditControlTypeId};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};

pub struct TypingProbe {
    requests: SyncSender<Instant>,
    results: Receiver<(Instant, Option<(f64, f64)>)>,
    next_request: Instant,
    pending_activity: bool,
}

impl TypingProbe {
    pub fn new() -> Self {
        let (requests, request_rx) = sync_channel::<Instant>(1);
        let (result_tx, results) = sync_channel(1);
        // The COM apartment lives on this worker only. Channels drop when recording
        // stops; don't join an external accessibility provider on the stop path.
        let _ = std::thread::Builder::new()
            .name("typing-focus".into())
            .spawn(move || {
                if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
                    return;
                }
                {
                    let automation: windows::core::Result<IUIAutomation> =
                        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) };
                    if let Ok(automation) = automation {
                        while let Ok(at) = request_rx.recv() {
                            let focus = focused_field(&automation);
                            let _ = result_tx.try_send((at, focus));
                        }
                    }
                }
                unsafe { CoUninitialize() };
            });
        Self {
            requests,
            results,
            next_request: Instant::now(),
            pending_activity: false,
        }
    }

    pub fn sample(&mut self) -> Option<(f64, f64)> {
        // Poll activity only. Never translate virtual keys to characters or store a key.
        // Ignore Ctrl/Alt/Win shortcuts; Shift remains allowed for ordinary typing.
        let shortcut = [0x11, 0x12, 0x5B, 0x5C].iter().any(|k| held(*k));
        let typing = !shortcut
            && ((0x30..=0x5A).any(held)
                || (0x60..=0x6F).any(held)
                || (0xBA..=0xE2).any(held)
                || held(0x20)
                || held(0x08)
                || held(0x0D));
        self.pending_activity |= typing;
        let now = Instant::now();
        if self.pending_activity && now >= self.next_request {
            let _ = self.requests.try_send(now);
            self.pending_activity = false;
            self.next_request = now + Duration::from_millis(200);
        }
        let mut latest = None;
        while let Ok((at, focus)) = self.results.try_recv() {
            if at.elapsed() <= Duration::from_millis(750) {
                latest = focus;
            }
        }
        latest
    }
}

fn held(key: i32) -> bool {
    (unsafe { GetAsyncKeyState(key) } as u16 & 0x8000) != 0
}

fn focused_field(automation: &IUIAutomation) -> Option<(f64, f64)> {
    unsafe {
        let element = automation.GetFocusedElement().ok()?;
        if element.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        // Standard text inputs (including Chromium textarea / input). Unknown controls
        // are skipped instead of zooming at a guessed mouse position.
        if element.CurrentControlType().ok()? != UIA_EditControlTypeId {
            return None;
        }
        let rect = element.CurrentBoundingRectangle().ok()?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(0, &mut info).is_ok() && !info.hwndCaret.is_invalid() {
            let mut caret = POINT {
                x: info.rcCaret.left,
                y: (info.rcCaret.top + info.rcCaret.bottom) / 2,
            };
            if ClientToScreen(info.hwndCaret, &mut caret).as_bool()
                && caret.x >= rect.left
                && caret.x <= rect.right
                && caret.y >= rect.top
                && caret.y <= rect.bottom
            {
                return Some((f64::from(caret.x), f64::from(caret.y)));
            }
        }
        // Browsers often draw their own caret; use the real focused field's centre.
        Some((
            (f64::from(rect.left) + f64::from(rect.right)) / 2.0,
            (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0,
        ))
    }
}
