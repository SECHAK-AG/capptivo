//! Bring a target window forward before window capture.
//!
//! SCK only streams frames for windows in the on-screen shareable set (Recordly
//! uses the same gate). Activation uses AppKit + `reopen` (no Accessibility);
//! PID-based System Events is best-effort for unminimize / raise.

use crate::error::{AppError, AppResult};
use screencapturekit_sys::shareable_content::{
    ExcludingDesktopWindowsConfig, UnsafeSCShareableContent,
};
use std::process::Command;
use std::time::Duration;

const SETTLE_MS: u64 = 100;
const MAX_ATTEMPTS: u32 = 12;
const ACTIVATE_ALL_WINDOWS: usize = 1;
const ACTIVATE_IGNORE_OTHERS: usize = 1 << 1;

const WINDOW_GONE: &str =
    "This window was closed or is no longer available — choose another source.";
const NOT_ON_SCREEN: &str =
    "Couldn't bring this window on screen. Click its Dock icon or switch to its Space, then try again.";

/// Unminimize, activate the owning app, and raise the window when possible.
pub fn prepare_for_capture(window_id: u32) -> AppResult<()> {
    if is_capture_ready(window_id)? {
        tracing::debug!(window_id, "window already in on-screen capture set");
        return Ok(());
    }

    let (pid, app_name, title, bundle_id) = window_meta(window_id)?;

    for attempt in 1..=MAX_ATTEMPTS {
        activate_window(pid, &app_name, bundle_id.as_deref(), &title);
        std::thread::sleep(Duration::from_millis(SETTLE_MS));
        if is_capture_ready(window_id)? {
            tracing::debug!(window_id, attempt, %app_name, "window is on screen for capture");
            return Ok(());
        }
    }

    Err(AppError::InvalidSource(NOT_ON_SCREEN.into()))
}

/// Whether SCK will include this window in an on-screen capture session.
fn is_capture_ready(window_id: u32) -> AppResult<bool> {
    let content = shareable_content_on_screen()?;
    Ok(content
        .windows()
        .iter()
        .any(|w| w.get_window_id() == window_id))
}

fn window_meta(window_id: u32) -> AppResult<(i32, String, String, Option<String>)> {
    let content = shareable_content_all()?;
    let window = content
        .windows()
        .into_iter()
        .find(|w| w.get_window_id() == window_id)
        .ok_or_else(|| AppError::InvalidSource(WINDOW_GONE.into()))?;

    let owner = window.get_owning_application();
    let pid = owner.as_ref().map(|o| o.get_process_id()).unwrap_or(-1);
    let app_name = owner
        .as_ref()
        .and_then(|o| o.get_application_name())
        .unwrap_or_default();
    let bundle_id = owner.and_then(|o| o.get_bundle_identifier());
    let title = window.get_title().unwrap_or_default();
    Ok((pid, app_name, title, bundle_id))
}

fn shareable_content_all() -> AppResult<objc_id::Id<UnsafeSCShareableContent>> {
    UnsafeSCShareableContent::get().map_err(map_shareable_err)
}

fn shareable_content_on_screen() -> AppResult<objc_id::Id<UnsafeSCShareableContent>> {
    let config = ExcludingDesktopWindowsConfig::default();
    UnsafeSCShareableContent::get_with_config(&config).map_err(map_shareable_err)
}

fn map_shareable_err(e: String) -> AppError {
    if e.contains("declined TCC") || e.contains("not authorized") {
        AppError::PermissionDenied
    } else {
        AppError::Other(format!("SCShareableContent: {e}"))
    }
}

fn activate_window(pid: i32, app_name: &str, bundle_id: Option<&str>, title: &str) {
    if pid > 0 {
        activate_app(pid);
    }
    if let Some(bundle) = bundle_id.and_then(sanitize_bundle_id) {
        let _ = osascript_reopen_bundle(bundle);
        let _ = osascript_activate_bundle(bundle);
    }
    if let Some(name) = sanitize_app_name(app_name) {
        let _ = osascript_reopen(name);
        let _ = osascript_activate(name);
    }
    if pid > 0 {
        let _ = raise_window_via_ax_pid(pid, title);
    } else if let Some(name) = sanitize_app_name(app_name) {
        let _ = raise_window_via_ax_name(name, title);
    }
}

fn activate_app(pid: i32) {
    use objc::{class, msg_send, sel, sel_impl};
    use objc::runtime::{BOOL, Object};

    unsafe {
        let app: *mut Object = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app.is_null() {
            return;
        }
        let _: BOOL = msg_send![app, unhide];
        let _: BOOL = msg_send![
            app,
            activateWithOptions: ACTIVATE_ALL_WINDOWS | ACTIVATE_IGNORE_OTHERS
        ];
    }
}

fn osascript_reopen(app_name: &str) -> Result<(), std::io::Error> {
    run_osascript_argv(&[
        "on run argv",
        "tell application (item 1 of argv) to reopen",
        "end run",
        "--",
        app_name,
    ])
}

fn osascript_activate(app_name: &str) -> Result<(), std::io::Error> {
    run_osascript_argv(&[
        "on run argv",
        "tell application (item 1 of argv) to activate",
        "end run",
        "--",
        app_name,
    ])
}

fn osascript_reopen_bundle(bundle_id: &str) -> Result<(), std::io::Error> {
    run_osascript_argv(&[
        "on run argv",
        "tell application id (item 1 of argv) to reopen",
        "end run",
        "--",
        bundle_id,
    ])
}

fn osascript_activate_bundle(bundle_id: &str) -> Result<(), std::io::Error> {
    run_osascript_argv(&[
        "on run argv",
        "tell application id (item 1 of argv) to activate",
        "end run",
        "--",
        bundle_id,
    ])
}

fn run_osascript_argv(args: &[&str]) -> Result<(), std::io::Error> {
    Command::new("osascript").args(args).output().map(|_| ())
}

/// Unminimize / raise by PID — more reliable than matching process display name.
fn raise_window_via_ax_pid(pid: i32, window_title: &str) -> Result<(), std::io::Error> {
    let title = escape_applescript(window_title);
    let script = if title.trim().is_empty() {
        format!(
            r#"tell application "System Events"
  tell (first process whose unix id is {pid})
    set frontmost to true
    try
      repeat with w in windows
        try
          if value of attribute "AXMinimized" of w is true then
            set value of attribute "AXMinimized" of w to false
          end if
        end try
      end repeat
      perform action "AXRaise" of (front window)
    end try
  end tell
end tell"#
        )
    } else {
        format!(
            r#"tell application "System Events"
  tell (first process whose unix id is {pid})
    set frontmost to true
    try
      repeat with w in windows
        if name of w contains "{title}" then
          try
            if value of attribute "AXMinimized" of w is true then
              set value of attribute "AXMinimized" of w to false
            end if
          end try
          perform action "AXRaise" of w
          exit repeat
        end if
      end repeat
    end try
  end tell
end tell"#
        )
    };
    Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map(|_| ())
}

fn raise_window_via_ax_name(app_name: &str, window_title: &str) -> Result<(), std::io::Error> {
    let app = escape_applescript(app_name);
    let title = escape_applescript(window_title);
    let script = format!(
        r#"tell application "System Events"
  tell process "{app}"
    set frontmost to true
    try
      repeat with w in windows
        if name of w contains "{title}" then
          try
            if value of attribute "AXMinimized" of w is true then
              set value of attribute "AXMinimized" of w to false
            end if
          end try
          perform action "AXRaise" of w
          exit repeat
        end if
      end repeat
    end try
  end tell
end tell"#
    );
    Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map(|_| ())
}

fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn sanitize_app_name(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    let ok = trimmed.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, ' ' | '.' | '&' | '(' | ')' | '+' | '\'' | '-')
    });
    if ok { Some(trimmed) } else { None }
}

fn sanitize_bundle_id(bundle: &str) -> Option<&str> {
    let trimmed = bundle.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if ok { Some(trimmed) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_app_name_matches_recordly_allowlist() {
        assert_eq!(sanitize_app_name("Google Chrome"), Some("Google Chrome"));
        assert_eq!(sanitize_app_name("  Safari  "), Some("Safari"));
        assert!(sanitize_app_name("bad;script").is_none());
    }

    #[test]
    fn sanitize_bundle_id_allows_apple_ids() {
        assert_eq!(
            sanitize_bundle_id("com.apple.dt.Xcode"),
            Some("com.apple.dt.Xcode")
        );
        assert!(sanitize_bundle_id("bad/id").is_none());
    }
}
