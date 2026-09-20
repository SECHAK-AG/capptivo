/**
 * Fetch pinned FFmpeg and ffprobe sidecars into `src-tauri/binaries/`.
 *
 * Every archive and extracted executable is checked against the committed
 * manifest before it can replace a cached sidecar. Existing cache entries are
 * reused only when their type, size, and SHA-256 digest still match.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs
 *   node scripts/fetch-ffmpeg.mjs --target x86_64-pc-windows-msvc
 *   node scripts/fetch-ffmpeg.mjs --all
 *   node scripts/fetch-ffmpeg.mjs --force
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST_DIR = join(ROOT, "src-tauri", "binaries");
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "ffmpeg-sidecars.json");
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_SIDECARS = ["capptivo-ffmpeg", "capptivo-ffprobe"];
const TARGETS = {
  "aarch64-apple-darwin": { exe: "" },
  "x86_64-apple-darwin": { exe: "" },
  "x86_64-pc-windows-msvc": { exe: ".exe" },
  "x86_64-unknown-linux-gnu": { exe: "" },
};

function fail(message) {
  throw new Error(`invalid FFmpeg sidecar manifest: ${message}`);
}

function isSafeArchivePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }

  const withoutTrailingSlash = path.replace(/\/+$/, "");
  const parts = withoutTrailingSlash.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function validateExpectedFile(file, context) {
  if (!file || typeof file !== "object") fail(`${context} must be an object`);
  if (!REQUIRED_SIDECARS.includes(file.sidecar)) {
    fail(`${context}.sidecar must name a supported sidecar`);
  }
  if (!isSafeArchivePath(file.archivePath) || file.archivePath.endsWith("/")) {
    fail(`${context}.archivePath must be a safe file path`);
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    fail(`${context}.size must be a positive integer`);
  }
  if (typeof file.sha256 !== "string" || !HASH_PATTERN.test(file.sha256)) {
    fail(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") fail("root must be an object");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!manifest.targets || typeof manifest.targets !== "object") {
    fail("targets must be an object");
  }

  const targetNames = Object.keys(manifest.targets).sort();
  const supportedNames = Object.keys(TARGETS).sort();
  if (JSON.stringify(targetNames) !== JSON.stringify(supportedNames)) {
    fail(`targets must be exactly: ${supportedNames.join(", ")}`);
  }

  for (const [triple, target] of Object.entries(manifest.targets)) {
    if (!target || typeof target !== "object" || !Array.isArray(target.archives)) {
      fail(`${triple}.archives must be an array`);
    }
    if (target.archives.length === 0) fail(`${triple}.archives must not be empty`);

    const urls = new Set();
    const sidecars = [];
    for (const [archiveIndex, archive] of target.archives.entries()) {
      const context = `${triple}.archives[${archiveIndex}]`;
      if (!archive || typeof archive !== "object") fail(`${context} must be an object`);

      let parsedUrl;
      try {
        parsedUrl = new URL(archive.url);
      } catch {
        fail(`${context}.url must be an absolute URL`);
      }
      if (parsedUrl.protocol !== "https:") fail(`${context}.url must use HTTPS`);
      if (parsedUrl.pathname.split("/").includes("latest")) {
        fail(`${context}.url must not use a floating latest path`);
      }
      if (urls.has(archive.url)) fail(`${context}.url is duplicated`);
      urls.add(archive.url);

      if (!Number.isSafeInteger(archive.size) || archive.size <= 0) {
        fail(`${context}.size must be a positive integer`);
      }
      if (typeof archive.sha256 !== "string" || !HASH_PATTERN.test(archive.sha256)) {
        fail(`${context}.sha256 must be a lowercase SHA-256 digest`);
      }
      if (!Array.isArray(archive.files) || archive.files.length === 0) {
        fail(`${context}.files must be a non-empty array`);
      }

      const archivePaths = new Set();
      for (const [fileIndex, file] of archive.files.entries()) {
        const fileContext = `${context}.files[${fileIndex}]`;
        validateExpectedFile(file, fileContext);
        if (archivePaths.has(file.archivePath)) fail(`${fileContext}.archivePath is duplicated`);
        archivePaths.add(file.archivePath);
        sidecars.push(file.sidecar);
      }
    }

    if (
      sidecars.length !== REQUIRED_SIDECARS.length ||
      REQUIRED_SIDECARS.some((sidecar) => sidecars.filter((item) => item === sidecar).length !== 1)
    ) {
      fail(`${triple} must provide each required sidecar exactly once`);
    }
  }

  return manifest;
}

const MANIFEST = validateManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));

function hostTriple() {
  const { platform, arch } = process;
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform: ${platform}/${arch}`);
}

function defaultTriple() {
  const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  return fromTauri || hostTriple();
}

function expectedFiles(target) {
  return target.archives.flatMap((archive) => archive.files);
}

export function destPath(sidecar, triple, destDir = DEST_DIR) {
  const target = TARGETS[triple];
  if (!target) throw new Error(`unsupported FFmpeg target: ${triple}`);
  return join(destDir, `${sidecar}-${triple}${target.exe}`);
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertVerifiedFile(
  path,
  expected,
  label = path,
  { requireExecutable = false } = {},
) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (requireExecutable && process.platform !== "win32") {
    try {
      accessSync(path, fsConstants.X_OK);
    } catch {
      throw new Error(`${label} is not executable by the current user`);
    }
  }
  if (stat.size !== expected.size) {
    throw new Error(`${label} has size ${stat.size}; expected ${expected.size}`);
  }
  const actual = await sha256File(path);
  if (actual !== expected.sha256) {
    throw new Error(`${label} has SHA-256 ${actual}; expected ${expected.sha256}`);
  }
}

export function assertArchiveMembers(entries, expectedPaths) {
  const counts = new Map();
  for (const entry of entries) {
    if (!isSafeArchivePath(entry)) throw new Error(`archive contains an unsafe path: ${entry}`);
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  for (const [entry, count] of counts) {
    if (count !== 1) throw new Error(`archive contains a duplicate path: ${entry}`);
  }
  for (const expectedPath of expectedPaths) {
    if (counts.get(expectedPath) !== 1) {
      throw new Error(`archive does not contain exactly one ${expectedPath}`);
    }
  }
}

function archiveEntries(archivePath) {
  const output = execFileSync("tar", ["-tf", archivePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split(/\r?\n/).filter((entry) => entry.length > 0);
}

function walkExtractedFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`archive extracted a symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) files.push(...walkExtractedFiles(path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`archive extracted a non-regular entry: ${relative(root, path)}`);
  }
  return files;
}

async function extractVerifiedArchive(archivePath, archive, outputDir) {
  const paths = archive.files.map((file) => file.archivePath);
  assertArchiveMembers(archiveEntries(archivePath), paths);

  execFileSync("tar", ["-xf", archivePath, "-C", outputDir, "--", ...paths], {
    stdio: "pipe",
  });

  const prepared = [];
  for (const file of archive.files) {
    const path = resolve(outputDir, ...file.archivePath.split("/"));
    const outputRoot = `${resolve(outputDir)}${sep}`;
    if (!path.startsWith(outputRoot)) throw new Error("extracted path escaped its staging directory");
    await assertVerifiedFile(path, file, `extracted ${file.sidecar}`);
    prepared.push({ ...file, path });
  }

  const expected = new Set(prepared.map((file) => file.path));
  const unexpected = walkExtractedFiles(outputDir).filter((path) => !expected.has(path));
  if (unexpected.length > 0) {
    throw new Error(`archive extracted an unexpected file: ${relative(outputDir, unexpected[0])}`);
  }
  return prepared;
}

async function downloadVerifiedArchive(archive, outputPath) {
  const response = await fetch(archive.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${archive.url} returned ${response.status}`);
  if (new URL(response.url).protocol !== "https:") {
    throw new Error(`GET ${archive.url} redirected outside HTTPS`);
  }
  if (!response.body) throw new Error(`GET ${archive.url} returned no body`);

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== archive.size) {
    throw new Error(`GET ${archive.url} declared ${contentLength} bytes; expected ${archive.size}`);
  }

  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > archive.size) {
        callback(new Error(`GET ${archive.url} exceeded ${archive.size} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    );
    if (bytes !== archive.size) {
      throw new Error(`GET ${archive.url} returned ${bytes} bytes; expected ${archive.size}`);
    }
    await assertVerifiedFile(outputPath, archive, `downloaded ${basename(new URL(archive.url).pathname)}`);
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}

export async function cacheStatus(triple, destDir = DEST_DIR, manifest = MANIFEST) {
  const target = manifest.targets[triple];
  if (!target) throw new Error(`no FFmpeg source for target ${triple}`);
  const failures = [];
  for (const file of expectedFiles(target)) {
    const path = destPath(file.sidecar, triple, destDir);
    try {
      await assertVerifiedFile(path, file, `cached ${file.sidecar}`, {
        requireExecutable: TARGETS[triple].exe === "",
      });
    } catch (error) {
      failures.push(error.message);
    }
  }
  return { valid: failures.length === 0, failures };
}

export async function promotePreparedFiles(prepared, triple, destDir = DEST_DIR) {
  const expectedSidecars = prepared.map((file) => file.sidecar).sort();
  if (JSON.stringify(expectedSidecars) !== JSON.stringify([...REQUIRED_SIDECARS].sort())) {
    throw new Error("prepared files must contain each required sidecar exactly once");
  }

  for (const file of prepared) {
    await assertVerifiedFile(file.path, file, `prepared ${file.sidecar}`);
  }

  mkdirSync(destDir, { recursive: true });
  const staged = [];
  try {
    for (const file of prepared) {
      const destination = destPath(file.sidecar, triple, destDir);
      const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
      const stagedFile = { destination, temporary, file };
      staged.push(stagedFile);
      copyFileSync(file.path, temporary, fsConstants.COPYFILE_EXCL);
      if (!TARGETS[triple].exe) chmodSync(temporary, 0o755);
      await assertVerifiedFile(temporary, file, `staged ${file.sidecar}`, {
        requireExecutable: TARGETS[triple].exe === "",
      });
    }

    for (const item of staged) {
      rmSync(item.destination, { force: true });
      renameSync(item.temporary, item.destination);
      await assertVerifiedFile(item.destination, item.file, `installed ${item.file.sidecar}`, {
        requireExecutable: TARGETS[triple].exe === "",
      });
    }
  } finally {
    for (const item of staged) rmSync(item.temporary, { force: true });
  }
}

async function fetchTarget(triple, force) {
  const target = MANIFEST.targets[triple];
  if (!target) {
    throw new Error(
      `no FFmpeg source for target "${triple}" (supported: ${Object.keys(TARGETS).join(", ")})`,
    );
  }

  const cached = await cacheStatus(triple);
  if (!force && cached.valid) {
    console.log(`FFmpeg sidecars for ${triple} are verified and already present`);
    return;
  }
  if (!force && cached.failures.some((failure) => !failure.includes("is unavailable"))) {
    console.log(`Cached FFmpeg sidecars for ${triple} failed verification; replacing them`);
  }

  console.log(`Fetching pinned FFmpeg sidecars for ${triple}`);
  const work = mkdtempSync(join(tmpdir(), "capptivo-ffmpeg-"));
  try {
    const prepared = [];
    for (const [index, archive] of target.archives.entries()) {
      const archivePath = join(work, `archive-${index}-${basename(new URL(archive.url).pathname)}`);
      const extractedDir = join(work, `extracted-${index}`);
      mkdirSync(extractedDir);
      await downloadVerifiedArchive(archive, archivePath);
      prepared.push(...(await extractVerifiedArchive(archivePath, archive, extractedDir)));
    }
    await promotePreparedFiles(prepared, triple);

    const installed = await cacheStatus(triple);
    if (!installed.valid) {
      throw new Error(`installed FFmpeg sidecars failed verification: ${installed.failures.join("; ")}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function parseArguments(args) {
  let all = false;
  let force = false;
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") all = true;
    else if (arg === "--force") force = true;
    else if (arg === "--target") {
      target = args[index + 1];
      if (!target || target.startsWith("--")) throw new Error("--target requires a target triple");
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (all && target) throw new Error("--all and --target cannot be used together");
  return { force, targets: all ? Object.keys(TARGETS) : [target ?? defaultTriple()] };
}

export async function main(args = process.argv.slice(2)) {
  const { force, targets } = parseArguments(args);
  for (const triple of targets) await fetchTarget(triple, force);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`fetch-ffmpeg failed: ${error.message}`);
    process.exitCode = 1;
  }
}
