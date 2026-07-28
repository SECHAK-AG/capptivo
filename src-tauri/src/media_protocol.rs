//! `media://` custom protocol with HTTP Range support (§10). The editor's
//! `<video>` elements and mediabunny's chunked reads need byte-range requests;
//! without them, every seek in a multi-GB recording re-reads the whole file and
//! export crawls. Reads are strictly scoped inside the projects directory.
//!
//! URL shape: `media://localhost/<projectId>/<file>` (e.g. `.../screen.mp4`).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

/// A no-Range GET is served whole only up to this size; larger files fall back
/// to a bounded 206 window so a plain request can't pull a multi-GB file into RAM.
const WHOLE_FILE_CAP: u64 = 16 * 1024 * 1024;
/// The window returned for an over-cap no-Range GET.
const WHOLE_FILE_WINDOW: u64 = 8 * 1024 * 1024;

/// Serve a `media://` request from within `projects_root`. Honors a single
/// `Range: bytes=start-end` header with a `206 Partial Content` response.
pub fn serve(projects_root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = resolve_path(projects_root, request.uri().path()) else {
        return error(StatusCode::FORBIDDEN, "invalid media path");
    };

    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return error(StatusCode::NOT_FOUND, "media not found"),
    };
    let total = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "stat failed"),
    };
    let content_type = content_type_for(&path);
    let range_header = request.headers().get(header::RANGE);

    match parse_range(range_header, total) {
        Some((start, end)) => {
            // end is inclusive.
            let len = end - start + 1;
            let mut buf = vec![0u8; len as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
            }
            cors(Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, len.to_string())
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}")))
                .body(buf)
                .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "build failed"))
        }
        // A Range header that's present but unsatisfiable (e.g. `start >= total`,
        // which the ranged blob loader sends once it reaches EOF) must NOT fall
        // through to the whole-file branch — that would re-serve the first window
        // and the client would never terminate. Answer 416 so it detects EOF.
        None if range_header.is_some() => cors(Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}")))
            .body(Vec::new())
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "build failed")),
        None => {
            // No Range header. Reading a whole multi-GB recording into memory on
            // the protocol thread is a footgun, so cap it: small files are served
            // whole; larger ones return a bounded first window as 206 and rely on
            // the client continuing via Range (our <video> and export consumers
            // both do). `Accept-Ranges` is always advertised.
            if total <= WHOLE_FILE_CAP {
                let mut buf = Vec::with_capacity(total as usize);
                if file.read_to_end(&mut buf).is_err() {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
                }
                cors(Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, total.to_string()))
                    .body(buf)
                    .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "build failed"))
            } else {
                let end = WHOLE_FILE_WINDOW.min(total) - 1;
                let len = end + 1;
                let mut buf = vec![0u8; len as usize];
                if file.read_exact(&mut buf).is_err() {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
                }
                cors(Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, len.to_string())
                    .header(header::CONTENT_RANGE, format!("bytes 0-{end}/{total}")))
                    .body(buf)
                    .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "build failed"))
            }
        }
    }
}

/// Apply the CORS headers every media response needs. Ranged `fetch()` (used to
/// assemble same-origin `blob:` URLs for GPU compositing) needs these.
/// WKWebView still treats `media://` `<video>` as insecure for WebGL/WebGPU
/// texture upload — preview/export must materialize `blob:` first (see
/// `mediaBlobUrl.ts`). **`Expose-Headers` is essential** — without it a
/// cross-origin `fetch()` cannot read `Content-Range`, so the ranged blob
/// loader can't learn the file size and stops after the first window,
/// truncating the recording (which froze exports past ~8 MiB of media).
fn cors(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        )
}

/// Resolve a request path to an absolute file **strictly inside** `projects_root`.
/// Rejects `..`, absolute segments, and anything that escapes the root.
fn resolve_path(projects_root: &Path, uri_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(uri_path);
    let rel = decoded.trim_start_matches('/');
    if rel.is_empty() {
        return None;
    }

    let mut resolved = projects_root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            // Any parent/root/prefix component is a traversal attempt.
            _ => return None,
        }
    }

    // Defense in depth: the canonical path must still live under the root.
    let canonical_root = projects_root.canonicalize().ok()?;
    let canonical = resolved.canonicalize().ok()?;
    if canonical.starts_with(&canonical_root) {
        Some(canonical)
    } else {
        None
    }
}

/// Parse `bytes=start-end`. Returns an inclusive `(start, end)` clamped to the
/// file, or `None` for absent/malformed/unsatisfiable ranges (caller sends 200).
fn parse_range(header: Option<&header::HeaderValue>, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let raw = header?.to_str().ok()?;
    let spec = raw.strip_prefix("bytes=")?;
    // Only the first range of a possibly-multi range set is honored.
    let first = spec.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;

    let (start, end) = match (start_s.trim(), end_s.trim()) {
        // `bytes=-N` → last N bytes.
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            let n = n.min(total);
            (total - n, total - 1)
        }
        // `bytes=N-` → open-ended. Serving to EOF would materialize a
        // multi-GB tail into the response `Vec` (custom-protocol responses
        // aren't streamed), so clamp to a bounded window — RFC 7233 allows a
        // 206 to carry a subrange, and every consumer here (WebKit media
        // loader, export readers) resumes from `Content-Range`.
        (s, "") => {
            let start: u64 = s.parse().ok()?;
            (start, start.saturating_add(WHOLE_FILE_WINDOW - 1))
        }
        // `bytes=S-E`.
        (s, e) => (s.parse().ok()?, e.parse().ok()?),
    };

    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("json") => "application/json",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

/// Minimal percent-decoding (enough for spaces / non-ASCII titles in file names).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(message.as_bytes().to_vec())
        .expect("static error response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        let root = std::env::temp_dir();
        assert!(resolve_path(&root, "/../etc/passwd").is_none());
        assert!(resolve_path(&root, "/a/../../b").is_none());
        assert!(resolve_path(&root, "/").is_none());
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range_str("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range_str("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range_str("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range_str("bytes=2000-3000", 1000), None);
        assert_eq!(parse_range_str("garbage", 1000), None);
    }

    #[test]
    fn open_ended_range_is_clamped_to_a_window() {
        // A `bytes=N-` on a multi-GB file must never materialize the whole
        // tail — it returns one bounded window and the client resumes.
        let total = 4 * 1024 * 1024 * 1024u64; // 4 GiB
        let start = 1_000_000;
        assert_eq!(
            parse_range_str(&format!("bytes={start}-"), total),
            Some((start, start + WHOLE_FILE_WINDOW - 1))
        );
        // Near EOF the window clamps to the last byte, not past it.
        let near_end = total - 10;
        assert_eq!(
            parse_range_str(&format!("bytes={near_end}-"), total),
            Some((near_end, total - 1))
        );
    }

    fn parse_range_str(s: &str, total: u64) -> Option<(u64, u64)> {
        let value = header::HeaderValue::from_str(s).unwrap();
        parse_range(Some(&value), total)
    }
}
