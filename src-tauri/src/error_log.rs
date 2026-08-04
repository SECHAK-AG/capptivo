//! Error-only persistent log for friend installs / support.
//!
//! Path: `{app_data}/logs/errors.log` (Windows: `%APPDATA%\com.capptivo.desktop\logs\errors.log`).
//! Captures `tracing::error!`, Rust panics, and JS `log_client_error` — never info/warn.

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const APP_ID: &str = "com.capptivo.desktop";
const LOG_NAME: &str = "errors.log";
/// Soft cap — rewrite keeping the tail when exceeded.
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const KEEP_TAIL: u64 = 512 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve + create the log file; install panic hook. Safe to call once at boot.
pub fn init() {
    let path = default_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = LOG_PATH.set(path);
    let _ = ensure_file();

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".into());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<Any>".into()
        };
        append("panic", &format!("{payload} @ {loc}"));
        previous(info);
    }));
}

pub fn log_path() -> PathBuf {
    LOG_PATH.get().cloned().unwrap_or_else(default_log_path)
}

/// Append one error line. Never panics; failures are silent.
pub fn append(source: &str, message: &str) {
    let msg = message.trim();
    if msg.is_empty() {
        return;
    }
    let line = format!(
        "{} ERROR [{}] {}\n",
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"),
        sanitize(source),
        sanitize_message(msg),
    );
    let _guard = WRITE_LOCK.lock();
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    rotate_if_huge(&path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

/// Reveal `errors.log` in the OS file manager. Creates an empty file if missing.
pub fn reveal() -> AppResult<PathBuf> {
    let path = ensure_file()?;
    opener_reveal(&path)?;
    Ok(path)
}

fn ensure_file() -> AppResult<PathBuf> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        File::create(&path)?;
    }
    Ok(path)
}

fn default_log_path() -> PathBuf {
    app_data_root().join("logs").join(LOG_NAME)
}

fn app_data_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(APP_ID);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_ID);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join(APP_ID);
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(APP_ID);
        }
    }
    std::env::temp_dir().join("Capptivo").join(APP_ID)
}

fn rotate_if_huge(path: &Path) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_BYTES {
        return;
    }
    let Ok(data) = fs::read(path) else {
        return;
    };
    let start = data.len().saturating_sub(KEEP_TAIL as usize);
    let mut tail = data[start..].to_vec();
    if let Some(i) = tail.iter().position(|&b| b == b'\n') {
        tail = tail[i + 1..].to_vec();
    }
    let _ = fs::write(path, tail);
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(64)
        .collect()
}

fn sanitize_message(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\n' | '\r' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .take(4000)
        .collect()
}

fn opener_reveal(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R"])
            .arg(path)
            .spawn()
            .map_err(|e| AppError::Other(format!("reveal log failed: {e}")))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        // `explorer /select,path` highlights the file.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| AppError::Other(format!("reveal log failed: {e}")))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| AppError::Other(format!("reveal log failed: {e}")))?;
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err(AppError::Unsupported)
    }
}

/// Tracing layer: only [`Level::ERROR`] events hit the file.
pub struct ErrorFileLayer;

impl<S> Layer<S> for ErrorFileLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if *event.metadata().level() != Level::ERROR {
            return;
        }
        let mut visitor = ErrorVisitor::default();
        event.record(&mut visitor);
        let target = event.metadata().target();
        let msg = if visitor.message.is_empty() {
            visitor.fields
        } else if visitor.fields.is_empty() {
            visitor.message
        } else {
            format!("{} {}", visitor.message, visitor.fields)
        };
        append(target, &msg);
    }
}

#[derive(Default)]
struct ErrorVisitor {
    message: String,
    fields: String,
}

impl Visit for ErrorVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.push_field(field.name(), value);
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
            // Prefer unquoted Display-ish for String debug
            if self.message.starts_with('"') && self.message.ends_with('"') && self.message.len() >= 2
            {
                self.message = self.message[1..self.message.len() - 1].to_string();
            }
        } else {
            self.push_field(field.name(), &format!("{value:?}"));
        }
    }
}

impl ErrorVisitor {
    fn push_field(&mut self, name: &str, value: &str) {
        if !self.fields.is_empty() {
            self.fields.push(' ');
        }
        self.fields.push_str(name);
        self.fields.push('=');
        self.fields.push_str(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_newlines() {
        assert!(!sanitize_message("a\nb\rc").contains('\n'));
    }
}
