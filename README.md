<p align="center">
  <img src="public/logo-capptivo.svg" width="300" alt="Capptivo" />
</p>

<p align="center">
  <strong>Give your demos the spotlight they deserve
</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.0.3-e66028?style=for-the-badge&labelColor=111" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=111" />
  <img alt="platform" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-555?style=for-the-badge&labelColor=111&label=platform" />
  <img alt="tauri" src="https://img.shields.io/badge/Tauri-24C8DB?style=for-the-badge&labelColor=111&logo=tauri&logoColor=24C8DB" />
  <img alt="rust" src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&labelColor=111&logo=rust&logoColor=white" />
  <img alt="react" src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&labelColor=111&logo=react&logoColor=61DAFB" />
</p>

<p>
  Capptivo is your free, open-source alternative to Screen Studio and Cursorful. Create stunning screen recordings in seconds, not hours. Smart follow-cursor zoom, click-based auto zooms, editor presets, and on-device captions, your demos practically make themselves.
</p>

<p> Capptivo isn't a clone of Screen Studio, it's a tool I built for myself, with every feature designed around my own needs. Now I'm open-sourcing it under the <strong>MIT license</strong> so anyone can use, improve, and customize it — freely, in any project.

No more paying $29/month for video editing software. I hope you enjoy it, and contributions are always welcome. </p>

<p align="center">
  <a href="#download">Download</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#development">Development</a>
  ·
  <a href="#license">License</a>
</p>

https://github.com/user-attachments/assets/246054fe-8604-4ea0-ae7b-701eaafc25bf

---

## Download

Installers are published on the
[GitHub Releases](https://github.com/SECHAK-AG/capptivo/releases) page
([latest](https://github.com/SECHAK-AG/capptivo/releases/latest)).

| Platform            | What to grab                                               |
| ------------------- | ---------------------------------------------------------- |
| macOS Apple Silicon | `aarch64` / `aarch64-apple-darwin` `.dmg` or `.app.tar.gz` |
| macOS Intel         | `x64` / `x86_64` `.dmg` or `.app.tar.gz`                   |
| Windows             | `.msi` or `*-setup.exe`                                    |
| Linux               | `.deb` / `.AppImage` / `.rpm`                              |

macOS builds are currently **unsigned**. On first launch: right-click → **Open**,
or allow Capptivo under System Settings → Privacy & Security. Grant **Screen
Recording** when prompted, then relaunch.

Captions need a system [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
`whisper-cli` binary; the app downloads the model weights on first use.

### Maintainers: cutting a release

GitHub Actions builds macOS (Intel + Apple Silicon), Windows, and Linux
installers — no local Windows/Linux machines needed.

1. Bump the desktop version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `desktop` package entry in `src-tauri/Cargo.lock`.
   Keep all four entries identical.
2. Commit and push the version change to the canonical [`SECHAK-AG/capptivo`](https://github.com/SECHAK-AG/capptivo) default branch.
   Create and push a matching tag, for example `v0.1.0`:

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

3. From the [Release workflow](https://github.com/SECHAK-AG/capptivo/actions/workflows/release.yml), select the canonical default branch and run it manually with that existing tag.
   The workflow accepts only a `vMAJOR.MINOR.PATCH` tag whose commit is reachable from the canonical default branch and whose four version entries match the tag.
   It creates or replaces the assets of a **draft** GitHub Release.
   Review and publish the draft separately

**Release environment and signing:** Configure the protected `release` environment with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
They are required to sign the updater artifacts for every platform.
The current macOS bundles are ad hoc signed and not notarized.
Windows bundles are not Authenticode-signed.
Apple notarization and Windows code-signing credentials are separate future work

**Permissions:** Keep the repository-default `GITHUB_TOKEN` permissions read-only.
The publish job grants only its own `contents: write` scope.
If policy blocks that scope, review the organization or enterprise Actions policy

---

## Platforms

Capptivo runs on:

- **macOS** 13.0+
- **Windows** 10 build 1903+ (May 2019 Update)
- **Linux** on modern distros with PipeWire 1.0+ (e.g. Ubuntu 24.04+) — X11 and Wayland

Platform notes:

- **macOS** captures through native **ScreenCaptureKit** with **VideoToolbox** hardware
  H.264 encoding; system audio comes from a companion SCK stream.
- **Windows** captures through native **Windows.Graphics.Capture**, with hardware
  encoding probed per machine (NVENC / QuickSync / AMF / Media Foundation) and
  system audio via **WASAPI loopback**.
- **Linux** captures through **xdg-desktop-portal + PipeWire** — the screen/window is
  picked in the system dialog. System audio comes from the PulseAudio/PipeWire
  monitor. Cursor replay / follow-zoom use an X11 pointer probe on X11 sessions,
  and PipeWire cursor **Metadata** on Wayland when the portal supports it
  (otherwise the cursor is embedded in the recording and zoom-follow is unavailable).
  Area selection isn't available yet on Linux — crop in the editor instead.

---

## Quick start

```bash
corepack pnpm install
corepack pnpm tauri dev
```

Requires **Rust 1.98.0**, the **Node** version declared in `.node-version`, and
**Corepack**. The Rust toolchain file includes rustfmt and Clippy, while Corepack
selects the pinned pnpm release from `package.json`.
FFmpeg is fetched automatically as a per-platform sidecar on first dev/build
(`scripts/fetch-ffmpeg.mjs`), installed as `capptivo-ffmpeg` /
`capptivo-ffprobe` so Linux packages do not collide with the system `ffmpeg`
package. Exact source URLs, archive members, sizes, and SHA-256 digests are
committed in `scripts/ffmpeg-sidecars.json`. The fetcher verifies downloaded,
extracted, staged, and cached files before it permits Tauri's chained command
to continue; a missing or invalid cache entry is replaced from the pinned
source.

On Windows, a portable Rust 1.98.0 toolchain can be placed under `.local`. Run
development commands through the repository launcher so Rust is selected only
from that directory:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/with-local-rust.ps1 corepack pnpm tauri dev
```

The launcher prefers a verified versioned MSVC toolchain, such as
`.local/rustup/toolchains/1.98.0-x86_64-pc-windows-msvc/bin`, and uses a sole
matching alias only when that directory is absent. It keeps Cargo state and
build output under `.local`, does not install or download Rust, and does not
fall back to a host toolchain. Native Windows builds still require the MSVC C++
Build Tools, including `link.exe`, on `PATH`; the
portable directory replaces only the Rust installation.

macOS: grant Screen Recording in System Settings on first launch, then relaunch.  
Open the recorder with **⌥⇧R** (**Alt+Shift+R** on Windows/Linux), or click the tray icon.

---

## Features

### Recording

- Menubar recorder with global hotkey (**⌥⇧R**)
- Capture display, window, or custom area (with live frame guide)
- Face-cam overlay while recording
- Microphone capture (device picker)
- System audio capture
- Language switch (English / Français / Español / Italiano / Deutsch / Português / Русский / 日本語 / 한국어 / 中文 / العربية)
- Countdown before start
- Pause / resume
- On-screen annotations while recording
- Native pipeline per OS (ScreenCaptureKit / Windows.Graphics.Capture / PipeWire) → hardware H.264 → crash-safe fragmented MP4
- 60 Hz cursor + click track saved with the project (`cursor.json`)

![Capptivo recording bar](assets/recording-bar-capptivo.webp)
![Capptivo annotation bar](assets/annotation-bar-capptivo.webp)

### Annotations

Draw on top of the screen while recording — floating toolbar, click-through when idle.

- Select tool (pass clicks through to the desktop)
- Pen and highlighter
- Eraser
- Shapes: rectangle, ellipse, line, arrow
- Text
- Color palette + custom picker
- Brush size
- Undo / redo / clear all
- Draggable toolbar; Escape peels panels then closes

![On-screen annotations while recording](assets/annotation-demo.gif)

### Zoom & motion

- Zoom fragments on the timeline (add with **Z** or Add fragment)
- **Auto-suggest zooms** from clicks when you open a fresh recording (or Add fragment → Suggest zooms)
- Follow-cursor zoom (pans with the pointer)
- Fixed zoom regions (drag / resize the frame)
- Scope: recording only or full scene (background included)
- Scale, pan smoothness, ease in / ease out
- Shrink background padding during zoom
- Shrink face-cam during zoom (size at peak zoom)
- Automatic motion between fragments

![Follow-cursor zoom and motion](assets/zoom-demo.gif)

### Cursor

- Show / hide composited cursor
- Styles: macOS, Tahoe, Tahoe inverted, Minimal
- Cursor size
- Motion blur
- Click bounce + bounce speed
- Cursor sway

![Cursor style and motion](assets/demo-cursor.gif)

### Look & composition

- Backgrounds: image presets, gradients, solid colors, or upload your own
- Custom gradient angle / colors
- **Named editor presets** — save / apply look, face cam, cursor, captions, and export settings
- Screen content crop (hide chrome / clutter)
- Video padding
- Recording corner radius
- Recording shadow
- Background blur
- Background darkness

![Backgrounds, padding, and composition](assets/appearance-demo.gif)

### Face cam

- Round or rectangular PiP
- Mirror webcam
- Corner position + margin from the frame edge
- Size / width / height
- Roundness (rectangular)
- Shadow intensity
- Crop face cam
- Layout that stays in sync with zoom (optional shrink during zoom)

### Captions

- On-device speech-to-text (Whisper via whisper.cpp)
- Downloadable model, no cloud required
- Generate, style, and burn captions into preview + export

![Captions demo](assets/captions-demo.gif)

### Timeline

- Scrub and play the composition
- Zoom fragments (add, suggest from clicks, select, resize, split, delete)
- Trim gaps (add with **T**)
- Undo / redo
- Timeline zoom (auto / manual)
- Reset fragments

### Export

- Formats: MP4, WebM, GIF
- Resolution presets (low → original)
- Encoding quality / GIF color quality
- Frame rate (24 / 30 / 60)
- Optional voice enhancement (podcast)
- Progress UI, save dialog, notification + reveal in Finder / Explorer / file manager

![Export demo](assets/export-demo.gif)

### Local-first

- Projects stored in the OS app-data directory (Application Support / AppData / XDG)
- In-app recordings library
- Rename projects
- No account required to record or edit
- UI languages: English, Français, Español, Italiano, Deutsch, Português, Русский, 日本語, 한국어, 中文, العربية

---

## Architecture

```
Capture  →  bounded frame channel  →  FFmpeg / VideoToolbox  →  screen.mp4
Cursor   →  cursor.json
UI       →  typed IPC projection of Rust state
Editor   →  media:// (HTTP Range) + canvas compositor → export
```

Rust owns capture, encoding, and storage. The React shell is presentation only — domain modules never import `tauri::*`.

```
src-tauri/src/
├── recorder/     # CaptureBackend → encoder (no Tauri)
├── cursor/       # 60 Hz pointer tracker (CoreGraphics / Win32 / X11)
├── project/      # local store + schema
├── commands/     # thin IPC adapters
└── …             # tray, windows, media protocol
```

---

## Development

```bash
corepack pnpm tauri dev        # app + Vite
cd src-tauri && cargo test --no-default-features
cargo check --no-default-features
```

Windows development with portable Rust uses the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/with-local-rust.ps1 cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
powershell -ExecutionPolicy Bypass -File scripts/with-local-rust.ps1 cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
```

---

## License

Copyright (c) 2026 idboussadel

Capptivo Desktop is released under the [MIT License](LICENSE) (`MIT`). You are
free to use, copy, modify, merge, publish, distribute, sublicense, and sell
copies of the software, provided the copyright notice and permission notice
are included in all copies or substantial portions of it.

The software is provided **"AS IS", WITHOUT WARRANTY OF ANY KIND**, express or
implied. See [LICENSE](LICENSE) for the full text.

Bundled and downloaded third-party components (notably the FFmpeg sidecars,
which are GPL-licensed) have their own licenses and are **not** covered by
Capptivo's MIT license — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for what that means if you redistribute builds.

By contributing, you agree that your contributions are licensed under the
same terms (`MIT`).
