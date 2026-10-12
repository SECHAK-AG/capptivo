## Highlights

### ⚡ Exports are up to 10× faster

MP4 export now runs on a new native render engine. Capptivo decodes the
recording, draws every frame on the GPU (Metal, DirectX 12 or Vulkan) and
encodes it with your machine's hardware H.264 encoder, with the audio muxed in
the same pass. The browser view is no longer in the frame path.

| Same 76-second project, 1080p at 60 fps, Apple M5 | Export time |
| ------------------------------------------------- | ----------- |
| Capptivo 1.0.3                                    | 176 s       |
| **Capptivo 1.0.4**                                | **17 s**    |

- The export draws the same zoom, cursor, face-cam, blur and caption timing
  you see in the editor. The motion math is checked against the editor's own
  code by an automated test suite.
- If the native engine can't export a project, Capptivo falls back to the
  previous exporter automatically, and the export still finishes.
- GIF and WebM exports still use the previous exporter.

### 🫥 Blur regions

Hide sensitive parts of a recording (emails, tokens, faces) with blur areas
in the editor's **Look** panel.

## What's changed

### Recording

- Stop a recording as soon as encoding fails, instead of recording into the void, by @advanivivek in #27
- Keep the timeline moving when the screen stops changing, by Sai Manikanta in #41
- Size the audio queue for a real encoder stall, and report overflow, by Sai Manikanta in #42
- Say when the camera flush times out before stop, by Sai Manikanta in #45
- Fix window recordings whose duration was always 0 (#33), by Sai Manikanta
- Keep HiDPI captures inside the hardware encoder's 4096 px limit, which no longer produces 0-byte takes (#33), by Daniel Nevoigt
- Probe hardware encoders at each recording frame size, by @Neonsy in #80
- Restore picker thumbnails on macOS 15+, by @MarsOccupied in #11
- Wayland: keep cursor metadata on more compositors and guard against a double stop, by @idboussadel

### Editor & export

- Native export engine (see Highlights), by @idboussadel
- Blur regions, by @MarsOccupied
- Back button to leave the recordings library, by @MarsOccupied in #12
- Faster preview proxies: GPU decode and GPU scale for proxy transcodes, by Sai Manikanta
- Stop encoder stalls from cutting takes, and make cancelling an export actually stop FFmpeg, by @idboussadel
- Get the annotation overlay off screen when its GPU context dies, by Sai Manikanta in #43

### Windows

- Explain unsupported capture devices and update the capture dependency, by @Neonsy in #76
- Make overlay exclusion fail closed, by @Neonsy in #77

### Reliability & diagnostics

- Keep fatal errors and surface live recording notices, by @Neonsy in #78
- Keep bounded local diagnostic codes, by @Neonsy in #79

### Security

- Keep export file paths behind native authority, so the editor only ever holds an opaque handle, by @Neonsy in #75
- Verify the bundled FFmpeg sidecars against pinned checksums, by @Neonsy in #72
- Update vulnerable transitive dependencies, by @Neonsy in #74

### Build & CI (for contributors)

- Pull request quality gates, Windows capture regression tests and a hardened release pipeline, by @Neonsy in #72
- Node 24, pnpm 12, a pinned Rust 1.98 toolchain and a rustfmt baseline, by @Neonsy in #72
- LF line endings and CRLF-safe cursor hotspot checks, by @Neonsy in #71 and #73

## New contributors 🎉

- @MarsOccupied made their first contribution in #11
- @advanivivek made their first contribution in #27
- @Neonsy made their first contribution in #71
- Sai Manikanta made their first contribution in #41
- Daniel Nevoigt made their first contribution

Thank you all! 🙏

**Full changelog:** https://github.com/SECHAK-AG/capptivo/compare/v1.0.3...v1.0.4

---

## Install

Download the installer for your platform below.

### macOS

The macOS builds are ad hoc signed rather than notarized.
On first launch, right-click the app and choose **Open**.
Grant **Screen Recording** in System Settings, then quit and reopen Capptivo.

### Captions

Captions require a system `whisper-cli` binary.
Capptivo downloads model weights on first use.

### Updates

Installed apps can use **Check for Updates** to install later releases.
