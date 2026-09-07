//! Local, bounded failure codes without event text, paths, or media

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const MAX_ENTRIES: usize = 200;
const MAX_READ_BYTES: u64 = 32 * 1024;
static LOG: OnceLock<DiagnosticLog> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    NativeWarning,
    NativeError,
    NativePanic,
    RecorderWarning,
    RecorderError,
    ExportWarning,
    ExportError,
    RendererError,
    RendererRecorderError,
    RendererExportError,
    RendererAnnotationError,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    timestamp: u64,
    code: Code,
}

struct DiagnosticLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl DiagnosticLog {
    fn new(app_data: &Path) -> Self {
        Self {
            path: app_data.join("diagnostics").join("diagnostics-v1.log"),
            lock: Mutex::new(()),
        }
    }

    fn entries(&self) -> std::io::Result<Vec<Entry>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut text = String::new();
        file.take(MAX_READ_BYTES + 1).read_to_string(&mut text)?;
        // Do not import oversized or unknown data into the next diagnostic snapshot
        if text.len() as u64 > MAX_READ_BYTES {
            return Ok(Vec::new());
        }
        Ok(text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect())
    }

    fn write(&self, entries: &[Entry]) -> std::io::Result<()> {
        let parent = self.path.parent().expect("diagnostic path has a parent");
        fs::create_dir_all(parent)?;
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        for entry in entries {
            serde_json::to_writer(&mut file, entry)?;
            file.write_all(b"\n")?;
        }
        file.flush()
    }

    fn append_locked(&self, code: Code) -> std::io::Result<()> {
        let mut entries = self.entries()?;
        let keep_from = entries.len().saturating_sub(MAX_ENTRIES - 1);
        entries.drain(..keep_from);
        entries.push(Entry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            code,
        });
        self.write(&entries)
    }

    fn append(&self, code: Code) -> std::io::Result<()> {
        let _guard = self.lock.lock();
        self.append_locked(code)
    }

    fn clear(&self) -> std::io::Result<()> {
        let _guard = self.lock.lock();
        self.write(&[])
    }

    fn ensure_file(&self) -> std::io::Result<()> {
        let _guard = self.lock.lock();
        let mut entries = self.entries()?;
        entries.drain(..entries.len().saturating_sub(MAX_ENTRIES));
        self.write(&entries)
    }
}

/// Configure after the single-instance lock is acquired, using Tauri's app-data path
pub fn init(app_data: &Path) {
    if LOG.set(DiagnosticLog::new(app_data)).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = LOG.get() {
            // A panic during a log write must not deadlock its own hook
            if let Some(_guard) = log.lock.try_lock() {
                let _ = log.append_locked(Code::NativePanic);
            }
        }
        previous(info);
    }));
}

fn configured() -> AppResult<&'static DiagnosticLog> {
    LOG.get()
        .ok_or_else(|| AppError::Other("local diagnostics are unavailable".into()))
}

pub fn log_path() -> AppResult<PathBuf> {
    Ok(configured()?.path.clone())
}

pub fn append(code: Code) {
    if let Some(log) = LOG.get() {
        // Diagnostics never turn a successful operation into a failure
        let _ = log.append(code);
    }
}

pub fn client_error_code(source: &str) -> Code {
    match source.split(':').next().unwrap_or_default() {
        "recorder" => Code::RendererRecorderError,
        "export" => Code::RendererExportError,
        "annotation" | "annotation-overlay" => Code::RendererAnnotationError,
        _ => Code::RendererError,
    }
}

pub fn clear() -> AppResult<()> {
    configured()?.clear()?;
    Ok(())
}

pub fn reveal() -> AppResult<PathBuf> {
    let log = configured()?;
    log.ensure_file()?;
    opener_reveal(&log.path)?;
    Ok(log.path.clone())
}

/// Existing IPC alias now reveals only the separate structured diagnostics folder
pub fn reveal_dir() -> AppResult<PathBuf> {
    let path = reveal()?;
    Ok(path
        .parent()
        .expect("diagnostic path has a parent")
        .to_path_buf())
}

fn opener_reveal(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().expect("diagnostic path has a parent"))
        .spawn();
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        result.map_err(|_| AppError::Other("could not open local diagnostics".into()))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err(AppError::Unsupported)
    }
}

pub struct ErrorFileLayer;

fn event_code(event: &Event<'_>) -> Option<Code> {
    let metadata = event.metadata();
    let warning = match *metadata.level() {
        Level::WARN => true,
        Level::ERROR => false,
        _ => return None,
    };
    // Never visit event fields, messages, spans, or arbitrary source text
    let target = metadata.target();
    Some(if target.starts_with("desktop_lib::recorder::") {
        if warning {
            Code::RecorderWarning
        } else {
            Code::RecorderError
        }
    } else if target.starts_with("desktop_lib::export_")
        || target == "desktop_lib::commands::export"
    {
        if warning {
            Code::ExportWarning
        } else {
            Code::ExportError
        }
    } else if warning {
        Code::NativeWarning
    } else {
        Code::NativeError
    })
}

impl<S: Subscriber> Layer<S> for ErrorFileLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if let Some(code) = event_code(event) {
            append(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tracing_subscriber::prelude::*;

    fn fixture() -> (PathBuf, DiagnosticLog) {
        let dir =
            std::env::temp_dir().join(format!("capptivo-diagnostics-{}", uuid::Uuid::new_v4()));
        let log = DiagnosticLog::new(&dir);
        (dir, log)
    }

    #[test]
    fn registered_layer_and_client_command_persist_only_codes() {
        const CHILD: &str = "CAPPTIVO_DIAGNOSTICS_TEST_CHILD";
        if let Some(dir) = std::env::var_os(CHILD) {
            let dir = PathBuf::from(dir);
            init(&dir);
            crate::init_tracing();
            tracing::error!(path = "private-fixture.mov", "private fixture text");
            crate::commands::error_log::log_client_error(
                "recorder:private-fixture".into(),
                "private fixture text".into(),
            )
            .unwrap();
            crate::commands::error_log::log_client_info(
                "private-fixture".into(),
                "private fixture text".into(),
            )
            .unwrap();
            let log = configured().unwrap();
            let entries = log.entries().unwrap();
            assert_eq!(
                entries.iter().map(|entry| entry.code).collect::<Vec<_>>(),
                vec![Code::NativeError, Code::RendererRecorderError]
            );
            let text = fs::read_to_string(&log.path).unwrap();
            assert!(!text.contains("private"));
            clear().unwrap();
            assert_eq!(fs::metadata(log_path().unwrap()).unwrap().len(), 0);
            return;
        }
        let (dir, _) = fixture();
        let mut child = crate::proc::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "error_log::tests::registered_layer_and_client_command_persist_only_codes",
            ])
            .env(CHILD, &dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("diagnostics child did not finish");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(status.success(), "diagnostics child failed: {status}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_latest_codes_and_clear_preserves_unrelated_files() {
        let (dir, log) = fixture();
        fs::create_dir_all(dir.join("logs")).unwrap();
        let legacy = dir.join("logs/errors.log");
        fs::write(&legacy, "legacy diagnostic fixture").unwrap();
        log.append(Code::NativePanic).unwrap();
        for _ in 0..MAX_ENTRIES {
            log.append(Code::RecorderError).unwrap();
        }
        let entries = log.entries().unwrap();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(entries
            .iter()
            .all(|entry| entry.code == Code::RecorderError));
        assert!(fs::metadata(&log.path).unwrap().len() < MAX_READ_BYTES);
        log.clear().unwrap();
        assert!(log.entries().unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(legacy).unwrap(),
            "legacy diagnostic fixture"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_or_unknown_rows_are_not_copied_forward() {
        let (dir, log) = fixture();
        log.ensure_file().unwrap();
        fs::write(
            &log.path,
            concat!(
                "{\"timestamp\":1,\"code\":\"native_error\"}\n",
                "{\"timestamp\":2,\"code\":\"private-fixture\"}\n",
                "{\"timestamp\":3,\"code\":\"native_error\",\"message\":\"private-fixture\"}\n",
                "{\"timestamp\":4"
            ),
        )
        .unwrap();
        log.append(Code::NativeWarning).unwrap();
        assert_eq!(log.entries().unwrap().len(), 2);
        assert!(!fs::read_to_string(&log.path)
            .unwrap()
            .contains("private-fixture"));
        fs::write(&log.path, vec![b'x'; MAX_READ_BYTES as usize + 1]).unwrap();
        log.append(Code::NativeError).unwrap();
        assert_eq!(log.entries().unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_writes_and_clear_leave_only_complete_bounded_rows() {
        let (dir, log) = fixture();
        let log = Arc::new(log);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let log = Arc::clone(&log);
                scope.spawn(move || {
                    for _ in 0..75 {
                        log.append(Code::NativeError).unwrap();
                    }
                });
            }
            let log = Arc::clone(&log);
            scope.spawn(move || log.clear().unwrap());
        });
        let text = fs::read_to_string(&log.path).unwrap();
        assert!(text.lines().count() <= MAX_ENTRIES);
        for line in text.lines() {
            serde_json::from_str::<Entry>(line).unwrap();
        }
        log.clear().unwrap();
        assert_eq!(fs::metadata(&log.path).unwrap().len(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trace_fields_are_never_formatted_and_info_is_ignored() {
        struct PrivateField;
        impl std::fmt::Debug for PrivateField {
            fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                panic!("diagnostic layer must not read fields");
            }
        }
        struct Capture(Arc<Mutex<Vec<Code>>>);
        impl<S: Subscriber> Layer<S> for Capture {
            fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
                if let Some(code) = event_code(event) {
                    self.0.lock().push(code);
                }
            }
        }
        let codes = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Capture(Arc::clone(&codes)));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(private = ?PrivateField, "ignored");
            tracing::warn!(target: "desktop_lib::recorder::encoder", private = ?PrivateField, "not recorded");
            tracing::error!(target: "desktop_lib::commands::export", private = ?PrivateField, "not recorded");
        });
        assert_eq!(
            *codes.lock(),
            vec![Code::RecorderWarning, Code::ExportError]
        );
        assert_eq!(
            client_error_code("recorder:private-fixture"),
            Code::RendererRecorderError
        );
        assert_eq!(client_error_code("private-fixture"), Code::RendererError);
    }
}
