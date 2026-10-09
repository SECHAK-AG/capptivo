//! Child-process plumbing for the FFmpeg sidecars.

use std::io::Read;
use std::path::Path;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::error::{EngineError, Result};

/// Keep only the tail of a chatty child's stderr.
const STDERR_TAIL_BYTES: usize = 16 * 1024;

/// A command that never flashes a console window on Windows.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run to completion and return stdout; stderr becomes the error on failure.
pub fn run_capture(program: &Path, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>> {
    let output = command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| EngineError::Process(format!("could not run {}: {e}", program.display())))?;
    if !output.status.success() {
        return Err(EngineError::Process(format!(
            "{} exited with {}: {}",
            program.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

/// Drains a child's stderr on a thread, keeping the last few KiB for errors.
pub struct StderrTail {
    text: Arc<Mutex<Vec<u8>>>,
    thread: Option<JoinHandle<()>>,
}

impl StderrTail {
    pub fn spawn(stderr: ChildStderr, name: &str) -> Self {
        let text = Arc::new(Mutex::new(Vec::new()));
        let sink = text.clone();
        let thread = std::thread::Builder::new()
            .name(format!("{name}-stderr"))
            .spawn(move || {
                let mut stderr = stderr;
                let mut chunk = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let mut buf = sink.lock().unwrap_or_else(|p| p.into_inner());
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > STDERR_TAIL_BYTES {
                        let excess = buf.len() - STDERR_TAIL_BYTES;
                        buf.drain(..excess);
                    }
                }
            })
            .ok();
        Self { text, thread }
    }

    /// What the child has said so far (after it exits, everything it said).
    pub fn snapshot(&self) -> String {
        let buf = self.text.lock().unwrap_or_else(|p| p.into_inner());
        String::from_utf8_lossy(&buf).trim().to_string()
    }

    /// Wait for the child's stderr to close, then return its tail.
    pub fn finish(&mut self) -> String {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.snapshot()
    }
}

/// Kill and reap a child; errors are irrelevant once we have given up on it.
pub fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
