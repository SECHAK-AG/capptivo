/**
 * Fetch static FFmpeg + ffprobe sidecar binaries into `src-tauri/binaries/`,
 * named per target triple the way Tauri's `bundle.externalBin` expects:
 *
 *   src-tauri/binaries/capptivo-ffmpeg-aarch64-apple-darwin
 *   src-tauri/binaries/capptivo-ffprobe-x86_64-pc-windows-msvc.exe
 *   …
 *
 * Sidecars are namespaced (`capptivo-*`) so Linux .deb/.rpm installs land at
 * `/usr/bin/capptivo-ffmpeg` instead of colliding with the system `ffmpeg`
 * package (https://github.com/SECHAK-AG/capptivo/issues/3).
 *
 * Runs automatically via `beforeDevCommand` / `beforeBuildCommand` and is
 * idempotent: if the binaries for the requested target already exist, it
 * exits immediately. The binaries are git-ignored — CI and each dev machine
 * fetch their own.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs             # host target (or TAURI_ENV_TARGET_TRIPLE)
 *   node scripts/fetch-ffmpeg.mjs --target x86_64-pc-windows-msvc
 *   node scripts/fetch-ffmpeg.mjs --all       # every supported target
 *   node scripts/fetch-ffmpeg.mjs --force     # re-download
 *
 * During `tauri build`, Tauri sets TAURI_ENV_TARGET_TRIPLE in beforeBuildCommand
 * so cross-compiles (e.g. x86_64-apple-darwin on an arm64 Mac) fetch the right
 * sidecars without an explicit --target.
 * Sources are GPL static builds (BtbN for Windows/Linux, martin-riedl.de for
 * macOS) because they include libx264 — Capptivo's software-encoder fallback
 * when no hardware encoder probes successfully. FFmpeg runs as a separate
 * process (spawned sidecar, no linking); if you prefer LGPL builds, swap the
 * BtbN URLs to the `-lgpl` variants and accept that the libx264 fallback
 * disappears on machines without NVENC/QSV/AMF/MF/VAAPI.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST_DIR = join(ROOT, "src-tauri", "binaries");

/** Archive member name → installed sidecar stem (Tauri `externalBin` basename). */
const TOOLS = [
  { archive: "ffmpeg", sidecar: "capptivo-ffmpeg" },
  { archive: "ffprobe", sidecar: "capptivo-ffprobe" },
];

/**
 * One entry per supported target triple.
 * - `zips`: one zip per tool, each containing the bare binary (martin-riedl).
 * - `bundle`: one archive containing `<top-dir>/bin/{ffmpeg,ffprobe}` (BtbN).
 */
const SOURCES = {
  "aarch64-apple-darwin": {
    kind: "zips",
    exe: "",
    urls: Object.fromEntries(
      TOOLS.map(({ archive }) => [
        archive,
        `https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/${archive}.zip`,
      ]),
    ),
  },
  "x86_64-apple-darwin": {
    kind: "zips",
    exe: "",
    urls: Object.fromEntries(
      TOOLS.map(({ archive }) => [
        archive,
        `https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/${archive}.zip`,
      ]),
    ),
  },
  "x86_64-pc-windows-msvc": {
    kind: "bundle",
    exe: ".exe",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  },
  "x86_64-unknown-linux-gnu": {
    kind: "bundle",
    exe: "",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
  },
};

function hostTriple() {
  const { platform, arch } = process;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  if (platform === "linux") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform: ${platform}/${arch}`);
}

/** Prefer Tauri's build target (set during beforeBuildCommand) over the host. */
function defaultTriple() {
  const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  return fromTauri || hostTriple();
}

function destPath(sidecar, triple) {
  return join(DEST_DIR, `${sidecar}-${triple}${SOURCES[triple].exe}`);
}

function hasAll(triple) {
  return TOOLS.every(({ sidecar }) => existsSync(destPath(sidecar, triple)));
}

async function download(url, toFile) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  writeFileSync(toFile, Buffer.from(await res.arrayBuffer()));
}

/** bsdtar (macOS/Windows) opens zips too; Linux only ever sees tar.xz here. */
function extract(archive, into) {
  execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
}

/** Find `name` anywhere under `dir` (archives differ in their top-level dir). */
function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

function install(from, sidecar, triple) {
  const to = destPath(sidecar, triple);
  copyFileSync(from, to);
  if (!SOURCES[triple].exe) chmodSync(to, 0o755);
  console.log(`  ✓ ${to.replace(`${ROOT}/`, "")}`);
}

async function fetchTarget(triple, force) {
  const source = SOURCES[triple];
  if (!source) {
    throw new Error(
      `no ffmpeg source for target "${triple}" (supported: ${Object.keys(SOURCES).join(", ")})`,
    );
  }
  if (!force && hasAll(triple)) {
    console.log(`ffmpeg sidecars for ${triple} already present — skipping`);
    return;
  }

  console.log(`Fetching FFmpeg sidecars for ${triple}…`);
  mkdirSync(DEST_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "capptivo-ffmpeg-"));
  try {
    if (source.kind === "zips") {
      for (const { archive, sidecar } of TOOLS) {
        const zipPath = join(work, `${archive}.zip`);
        await download(source.urls[archive], zipPath);
        const out = join(work, archive);
        mkdirSync(out);
        extract(zipPath, out);
        const bin = findFile(out, archive);
        if (!bin) throw new Error(`${archive} not found in ${source.urls[archive]}`);
        install(bin, sidecar, triple);
      }
    } else {
      const archivePath = join(work, source.url.split("/").pop());
      await download(source.url, archivePath);
      extract(archivePath, work);
      for (const { archive, sidecar } of TOOLS) {
        const bin = findFile(work, `${archive}${source.exe}`);
        if (!bin) throw new Error(`${archive} not found in ${source.url}`);
        install(bin, sidecar, triple);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const targetFlag = args.indexOf("--target");
const targets = args.includes("--all")
  ? Object.keys(SOURCES)
  : [targetFlag >= 0 ? args[targetFlag + 1] : defaultTriple()];

try {
  for (const triple of targets) {
    await fetchTarget(triple, force);
  }
} catch (err) {
  console.error(`fetch-ffmpeg failed: ${err.message}`);
  process.exit(1);
}
