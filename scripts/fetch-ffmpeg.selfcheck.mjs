import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArchiveMembers,
  assertVerifiedFile,
  cacheStatus,
  destPath,
  promotePreparedFiles,
  validateManifest,
} from "./fetch-ffmpeg.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(scriptsDir, "ffmpeg-sidecars.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedFile(sidecar, path, bytes) {
  return {
    archivePath: sidecar,
    sidecar,
    path,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

validateManifest(manifest);
assert.deepEqual(Object.keys(manifest.targets).sort(), [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]);
for (const target of Object.values(manifest.targets)) {
  for (const archive of target.archives) {
    assert.equal(new URL(archive.url).protocol, "https:");
    assert.equal(new URL(archive.url).pathname.split("/").includes("latest"), false);
    assert.match(archive.sha256, /^[0-9a-f]{64}$/);
    for (const file of archive.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
}

const floating = clone(manifest);
floating.targets["aarch64-apple-darwin"].archives[0].url =
  "https://example.invalid/redirect/latest/ffmpeg.zip";
assert.throws(() => validateManifest(floating), /floating latest path/);

assert.doesNotThrow(() =>
  assertArchiveMembers(["bundle/", "bundle/bin/", "bundle/bin/ffmpeg"], [
    "bundle/bin/ffmpeg",
  ]),
);
assert.throws(
  () => assertArchiveMembers(["bundle/bin/ffprobe"], ["bundle/bin/ffmpeg"]),
  /does not contain exactly one/,
);
assert.throws(
  () => assertArchiveMembers(["ffmpeg", "ffmpeg"], ["ffmpeg"]),
  /duplicate path/,
);
for (const unsafe of ["../ffmpeg", "bin/../ffmpeg", "/bin/ffmpeg", "C:/ffmpeg", "bin\\ffmpeg"]) {
  assert.throws(() => assertArchiveMembers([unsafe], [unsafe]), /unsafe path/);
}
const work = mkdtempSync(join(tmpdir(), "capptivo-ffmpeg-selfcheck-"));
try {
  const preparedDir = join(work, "prepared");
  const destDir = join(work, "cache");
  mkdirSync(preparedDir);
  mkdirSync(destDir);

  const ffmpegBytes = Buffer.from("verified ffmpeg bytes");
  const ffprobeBytes = Buffer.from("verified ffprobe bytes");
  const ffmpegPath = join(preparedDir, "ffmpeg.exe");
  const ffprobePath = join(preparedDir, "ffprobe.exe");
  writeFileSync(ffmpegPath, ffmpegBytes);
  writeFileSync(ffprobePath, ffprobeBytes);

  const ffmpeg = expectedFile("capptivo-ffmpeg", ffmpegPath, ffmpegBytes);
  const ffprobe = expectedFile("capptivo-ffprobe", ffprobePath, ffprobeBytes);
  await assertVerifiedFile(ffmpegPath, ffmpeg);
  writeFileSync(ffmpegPath, Buffer.from("tampered ffmpeg bytes"));
  await assert.rejects(() => assertVerifiedFile(ffmpegPath, ffmpeg), /SHA-256/);
  writeFileSync(ffmpegPath, ffmpegBytes);

  const oldFfmpeg = Buffer.from("old ffmpeg");
  const oldFfprobe = Buffer.from("old ffprobe");
  const cachedFfmpeg = destPath("capptivo-ffmpeg", "x86_64-pc-windows-msvc", destDir);
  const cachedFfprobe = destPath("capptivo-ffprobe", "x86_64-pc-windows-msvc", destDir);
  writeFileSync(cachedFfmpeg, oldFfmpeg);
  writeFileSync(cachedFfprobe, oldFfprobe);

  writeFileSync(ffprobePath, Buffer.from("tampered ffprobe bytes"));
  await assert.rejects(
    () => promotePreparedFiles([ffmpeg, ffprobe], "x86_64-pc-windows-msvc", destDir),
    /prepared capptivo-ffprobe/,
  );
  assert.deepEqual(readFileSync(cachedFfmpeg), oldFfmpeg);
  assert.deepEqual(readFileSync(cachedFfprobe), oldFfprobe);

  writeFileSync(ffprobePath, ffprobeBytes);
  await promotePreparedFiles([ffmpeg, ffprobe], "x86_64-pc-windows-msvc", destDir);
  assert.deepEqual(readFileSync(cachedFfmpeg), ffmpegBytes);
  assert.deepEqual(readFileSync(cachedFfprobe), ffprobeBytes);

  const testManifest = {
    targets: {
      "x86_64-pc-windows-msvc": {
        archives: [{ files: [ffmpeg, ffprobe] }],
      },
    },
  };
  assert.equal(
    (await cacheStatus("x86_64-pc-windows-msvc", destDir, testManifest)).valid,
    true,
  );
  writeFileSync(cachedFfprobe, Buffer.from("tampered ffprobe bytes"));
  const tamperedCache = await cacheStatus(
    "x86_64-pc-windows-msvc",
    destDir,
    testManifest,
  );
  assert.equal(tamperedCache.valid, false);
  assert.match(tamperedCache.failures.join("\n"), /cached capptivo-ffprobe/);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("fetch-ffmpeg.selfcheck: ok");
