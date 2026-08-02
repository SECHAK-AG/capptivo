# Third-party notices

Capptivo Desktop's own source is licensed under the [MIT License](LICENSE)
(`MIT`). This file documents **bundled or downloaded third-party components**
that ship with or alongside the app, and their licenses — several are under
stricter terms than MIT and are not re-licensed by Capptivo.

---

## FFmpeg / ffprobe (sidecar binaries)

Capptivo downloads static **FFmpeg** and **ffprobe** binaries at build time
(`scripts/fetch-ffmpeg.mjs`) and bundles them as Tauri `externalBin` sidecars
named `capptivo-ffmpeg` / `capptivo-ffprobe` (so Linux packages install them
beside the app without colliding with the system `ffmpeg` package). They run
as a **separate process** (no linking into Capptivo).

| Item | Detail |
|------|--------|
| Component | FFmpeg / ffprobe |
| Bundled names | `capptivo-ffmpeg`, `capptivo-ffprobe` |
| Typical license | GPL (static builds include GPL-licensed codecs such as libx264) |
| Sources used | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (Windows/Linux GPL builds); [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) (macOS) |
| Upstream | https://ffmpeg.org/ · https://github.com/FFmpeg/FFmpeg |

Corresponding FFmpeg source is available from the upstream project and from the
build providers above. If you redistribute Capptivo binaries, you must also
satisfy FFmpeg’s license terms for the bundled sidecars (including offering
source for those GPL components).

---

## whisper.cpp (optional, runtime)

Speech-to-text captions use a **system-installed** `whisper-cli` / whisper.cpp
binary when present (not bundled by default). The app may download the
`ggml-small.bin` model weights into app data on first use.

| Item | Detail |
|------|--------|
| whisper.cpp | https://github.com/ggerganov/whisper.cpp (MIT) |
| Model weights | `ggml-small.bin` from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) — see that project for model terms |

---

## Other dependencies

Frontend (npm) and Rust crate dependencies keep their own licenses. Inspect:

- `pnpm-lock.yaml` / each package’s `LICENSE`
- `src-tauri/Cargo.lock` / each crate’s `license` field on crates.io

Notable UI / media libraries used by Capptivo include React, Tauri, mediabunny,
gifenc, and various Radix UI packages — each under its upstream license (typically
MIT/Apache-2.0). They are not re-licensed by Capptivo; Capptivo's own code is
distributed under `MIT`.
