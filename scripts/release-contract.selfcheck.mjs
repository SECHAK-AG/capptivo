import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleUnsignedRelease,
  assertVersionContract,
  finalizeSignedRelease,
  readRepositoryVersions,
  stageArtifacts,
  validateChecksumCoverage,
  validateChecksums,
  validateReleaseReference,
} from "./release-contract.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const versions = readRepositoryVersions(REPOSITORY_ROOT);
const VERSION = versions["package.json"];
const [MAJOR, MINOR, PATCH] = VERSION.split(".").map(Number);
const NEXT_VERSION = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PUBLICATION_DATE = "2026-09-04T00:00:00.000Z";
const TAURI_CLI = join(REPOSITORY_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const TEST_KEY_PASSWORD = "release-contract-test-password";

const CASES = {
  "macos-aarch64": {
    target: "aarch64-apple-darwin",
    files: [
      `Capptivo_${VERSION}_aarch64.dmg`,
      "Capptivo.app.tar.gz",
    ],
  },
  "macos-x86_64": {
    target: "x86_64-apple-darwin",
    files: [`Capptivo_${VERSION}_x64.dmg`, "Capptivo.app.tar.gz"],
  },
  "linux-x86_64": {
    target: "x86_64-unknown-linux-gnu",
    files: [
      `Capptivo_${VERSION}_amd64.deb`,
      `Capptivo-${VERSION}-1.x86_64.rpm`,
      `Capptivo_${VERSION}_amd64.AppImage`,
    ],
  },
  "windows-x86_64": {
    target: "x86_64-pc-windows-msvc",
    files: [
      `Capptivo_${VERSION}_x64_en-US.msi`,
      `Capptivo_${VERSION}_x64-setup.exe`,
    ],
  },
};

function expectFailure(action, pattern) {
  assert.throws(action, pattern);
}

function createArtifactSource(root, directory, files, target) {
  const source = join(root, "src-tauri", "target", target, "release", "bundle", directory);
  mkdirSync(source, { recursive: true });
  return files.map((name) => {
    const path = join(source, name);
    writeFileSync(path, `${directory}:${name}\n`);
    return path;
  });
}

function mutateSignaturePacket(encodedSignature, offset) {
  const lines = Buffer.from(encodedSignature.trim(), "base64")
    .toString("utf8")
    .trimEnd()
    .split(/\r?\n/);
  const packet = Buffer.from(lines[1], "base64");
  packet[offset] ^= 0xff;
  lines[1] = packet.toString("base64");
  return `${Buffer.from(`${lines.join("\n")}\n`).toString("base64")}\n`;
}

assert.deepEqual(new Set(Object.values(versions)), new Set([VERSION]));
assert.equal(assertVersionContract(REPOSITORY_ROOT, `v${VERSION}`), VERSION);
const nextPatchTag = `v${NEXT_VERSION}`;
expectFailure(
  () => assertVersionContract(REPOSITORY_ROOT, nextPatchTag),
  new RegExp(`expected ${NEXT_VERSION.replaceAll(".", "\\.")} from ${nextPatchTag.replaceAll(".", "\\.")}`),
);

const root = mkdtempSync(join(tmpdir(), "capptivo-release-contract-"));
try {
  const signingKeyPath = join(root, "test-signing-key");
  execFileSync(
    process.execPath,
    [
      TAURI_CLI,
      "signer",
      "generate",
      "--ci",
      "--password",
      TEST_KEY_PASSWORD,
      "--write-keys",
      signingKeyPath,
    ],
    { stdio: "pipe" },
  );
  const testPublicKey = readFileSync(`${signingKeyPath}.pub`, "utf8").trim();
  const gitRoot = join(root, "git-contract");
  mkdirSync(join(gitRoot, "src-tauri"), { recursive: true });
  writeFileSync(join(gitRoot, "package.json"), `${JSON.stringify({ version: VERSION })}\n`);
  writeFileSync(
    join(gitRoot, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({
      version: VERSION,
      plugins: {
        updater: {
          pubkey: testPublicKey,
          endpoints: [
            "https://github.com/SECHAK-AG/capptivo/releases/latest/download/latest.json",
          ],
        },
      },
    })}\n`,
  );
  writeFileSync(join(gitRoot, "src-tauri", "Cargo.toml"), `[package]\nname = "desktop"\nversion = "${VERSION}"\n`);
  writeFileSync(
    join(gitRoot, "src-tauri", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "desktop"\nversion = "${VERSION}"\n`,
  );
  const git = (...arguments_) =>
    execFileSync("git", arguments_, { cwd: gitRoot, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Release Contract Test");
  git("config", "user.email", "release-contract@example.invalid");
  git("add", ".");
  git("commit", "-m", "Test release contract");
  const gitCommit = git("rev-parse", "HEAD");
  git("tag", `v${VERSION}`);
  git("update-ref", "refs/remotes/origin/main", gitCommit);
  assert.deepEqual(
    validateReleaseReference({
      root: gitRoot,
      tag: `v${VERSION}`,
      expectedSha: gitCommit,
      defaultBranch: "main",
      repository: "SECHAK-AG/capptivo",
    }).sha,
    gitCommit,
  );

  writeFileSync(join(gitRoot, "package.json"), `${JSON.stringify({ version: NEXT_VERSION })}\n`);
  writeFileSync(
    join(gitRoot, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({
      version: NEXT_VERSION,
      plugins: {
        updater: {
          pubkey: testPublicKey,
          endpoints: [
            "https://github.com/SECHAK-AG/capptivo/releases/latest/download/latest.json",
          ],
        },
      },
    })}\n`,
  );
  writeFileSync(
    join(gitRoot, "src-tauri", "Cargo.toml"),
    `[package]\nname = "desktop"\nversion = "${NEXT_VERSION}"\n`,
  );
  writeFileSync(
    join(gitRoot, "src-tauri", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "desktop"\nversion = "${NEXT_VERSION}"\n`,
  );
  git("add", ".");
  git("commit", "-m", "Advance default branch version");
  const advancedCommit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", advancedCommit);
  assert.equal(
    validateReleaseReference({
      root: gitRoot,
      tag: `v${VERSION}`,
      expectedSha: gitCommit,
      defaultBranch: "main",
      repository: "SECHAK-AG/capptivo",
    }).version,
    VERSION,
  );
  git("checkout", "--detach", gitCommit);
  expectFailure(
    () =>
      validateReleaseReference({
        root: gitRoot,
        tag: `v${VERSION}`,
        expectedSha: "f".repeat(40),
        defaultBranch: "main",
        repository: "SECHAK-AG/capptivo",
      }),
    /expected f{40}/,
  );
  const unrelatedCommit = git("commit-tree", git("write-tree"), "-m", "Unrelated default tip");
  git("update-ref", "refs/remotes/origin/main", unrelatedCommit);
  expectFailure(
    () =>
      validateReleaseReference({
        root: gitRoot,
        tag: `v${VERSION}`,
        defaultBranch: "main",
        repository: "SECHAK-AG/capptivo",
      }),
    /not reachable from refs\/remotes\/origin\/main/,
  );
  git("update-ref", "refs/remotes/origin/main", advancedCommit);

  const stagedRoot = join(root, "staged");
  mkdirSync(stagedRoot);
  for (const [platform, specification] of Object.entries(CASES)) {
    createArtifactSource(
      root,
      platform,
      specification.files,
      specification.target,
    );
    stageArtifacts({
      root,
      platform,
      target: specification.target,
      version: VERSION,
      commit: COMMIT,
      output: join(stagedRoot, `release-${platform}`),
    });
  }

  const notesPath = join(root, "release-notes.md");
  writeFileSync(notesPath, "Release notes\n");
  const unsignedOutput = join(root, "unsigned");
  assembleUnsignedRelease({
    root: gitRoot,
    stagedRoot,
    output: unsignedOutput,
    notesPath,
    tag: `v${VERSION}`,
    version: VERSION,
    commit: COMMIT,
    pubDate: PUBLICATION_DATE,
    repository: "SECHAK-AG/capptivo",
  });

  for (const name of [
    `Capptivo_${VERSION}_aarch64.app.tar.gz`,
    `Capptivo_${VERSION}_x64.app.tar.gz`,
    `Capptivo_${VERSION}_amd64.deb`,
    `Capptivo-${VERSION}-1.x86_64.rpm`,
    `Capptivo_${VERSION}_amd64.AppImage`,
    `Capptivo_${VERSION}_x64_en-US.msi`,
    `Capptivo_${VERSION}_x64-setup.exe`,
  ]) {
    execFileSync(
      process.execPath,
      [
        TAURI_CLI,
        "signer",
        "sign",
        "--private-key-path",
        signingKeyPath,
        "--password",
        TEST_KEY_PASSWORD,
        join(unsignedOutput, "payload", name),
      ],
      { stdio: "pipe" },
    );
  }

  const wrongKeyAsset = `Capptivo_${VERSION}_amd64.AppImage`;
  const wrongKeySignature = join(unsignedOutput, "payload", `${wrongKeyAsset}.sig`);
  const validSignature = readFileSync(wrongKeySignature, "utf8");
  writeFileSync(wrongKeySignature, mutateSignaturePacket(validSignature, 2));
  expectFailure(
    () =>
      finalizeSignedRelease({
        root: gitRoot,
        unsignedRoot: unsignedOutput,
        output: join(root, "wrong-key-output"),
        tag: `v${VERSION}`,
        version: VERSION,
        commit: COMMIT,
        pubDate: PUBLICATION_DATE,
        repository: "SECHAK-AG/capptivo",
      }),
    /does not match the configured updater public key/,
  );
  writeFileSync(wrongKeySignature, validSignature);

  writeFileSync(wrongKeySignature, mutateSignaturePacket(validSignature, 10));
  expectFailure(
    () =>
      finalizeSignedRelease({
        root: gitRoot,
        unsignedRoot: unsignedOutput,
        output: join(root, "invalid-signature-output"),
        tag: `v${VERSION}`,
        version: VERSION,
        commit: COMMIT,
        pubDate: PUBLICATION_DATE,
        repository: "SECHAK-AG/capptivo",
      }),
    /does not authenticate/,
  );
  writeFileSync(wrongKeySignature, validSignature);

  const output = join(root, "verified");
  const manifest = finalizeSignedRelease({
    root: gitRoot,
    unsignedRoot: unsignedOutput,
    output,
    tag: `v${VERSION}`,
    version: VERSION,
    commit: COMMIT,
    pubDate: PUBLICATION_DATE,
    repository: "SECHAK-AG/capptivo",
  });

  assert.equal(manifest.assets.length, 17);
  const latest = JSON.parse(readFileSync(join(output, "payload", "latest.json"), "utf8"));
  assert.deepEqual(Object.keys(latest.platforms), [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "linux-x86_64",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
  ]);
  assert.equal(
    latest.platforms["windows-x86_64"].url,
    `https://github.com/SECHAK-AG/capptivo/releases/download/v${VERSION}/Capptivo_${VERSION}_x64_en-US.msi`,
  );
  assert.ok(
    latest.platforms["darwin-aarch64"].url.endsWith(
      `/Capptivo_${VERSION}_aarch64.app.tar.gz`,
    ),
  );
  assert.equal(latest.notes, "Release notes\n");
  assert.match(readFileSync(join(output, "verified.sha256"), "utf8"), /payload\/latest\.json/);
  const checksumContents = readFileSync(join(output, "payload", "SHA256SUMS"), "utf8");
  const checksumNames = manifest.assets.map((entry) => entry.name).concat("release-manifest.json");
  assert.doesNotThrow(() => validateChecksumCoverage(checksumContents, checksumNames));
  assert.doesNotThrow(() => validateChecksums(join(output, "payload"), checksumContents, checksumNames));
  const checksumLines = checksumContents.trimEnd().split("\n");
  expectFailure(
    () => validateChecksumCoverage(`${checksumLines.slice(1).join("\n")}\n`, checksumNames),
    /checksum list is missing/,
  );
  expectFailure(
    () => validateChecksumCoverage(`${checksumLines.join("\n")}\n${checksumLines[0]}\n`, checksumNames),
    /checksum list repeats/,
  );
  const wrongDigest = `${checksumContents[0] === "0" ? "1" : "0"}${checksumContents.slice(1)}`;
  assert.doesNotThrow(() => validateChecksumCoverage(wrongDigest, checksumNames));
  expectFailure(
    () => validateChecksums(join(output, "payload"), wrongDigest, checksumNames),
    /checksum does not match/,
  );

  const tamperedStage = join(root, "tampered-staged");
  mkdirSync(tamperedStage);
  for (const [platform, specification] of Object.entries(CASES)) {
    const artifactPaths = createArtifactSource(
      root,
      `${platform}-tamper`,
      specification.files,
      specification.target,
    );
    stageArtifacts({
      root,
      platform,
      target: specification.target,
      version: VERSION,
      commit: COMMIT,
      artifactPaths,
      output: join(tamperedStage, `release-${platform}`),
    });
  }
  writeFileSync(
    join(tamperedStage, "release-windows-x86_64", `Capptivo_${VERSION}_x64_en-US.msi`),
    "tampered\n",
  );
  expectFailure(
    () =>
      assembleUnsignedRelease({
        root: REPOSITORY_ROOT,
        stagedRoot: tamperedStage,
        output: join(root, "tampered-output"),
        notesPath,
        tag: `v${VERSION}`,
        version: VERSION,
        commit: COMMIT,
        pubDate: PUBLICATION_DATE,
        repository: "SECHAK-AG/capptivo",
      }),
    /size does not match|hash does not match/,
  );

  const missingRoot = join(root, "missing");
  const missingPaths = createArtifactSource(
    missingRoot,
    "windows-x86_64",
    CASES["windows-x86_64"].files.filter((name) => !name.endsWith("-setup.exe")),
    CASES["windows-x86_64"].target,
  );
  expectFailure(
    () =>
      stageArtifacts({
        root: missingRoot,
        platform: "windows-x86_64",
        target: CASES["windows-x86_64"].target,
        version: VERSION,
        commit: COMMIT,
        artifactPaths: missingPaths,
        output: join(root, "missing-output"),
      }),
    /missing nsis/,
  );

  const outside = join(root, `Capptivo_${VERSION}_amd64.AppImage`);
  writeFileSync(outside, "outside\n");
  const outsidePaths = createArtifactSource(
    root,
    "linux-outside",
    CASES["linux-x86_64"].files,
    CASES["linux-x86_64"].target,
  );
  outsidePaths[outsidePaths.findIndex((path) => path.endsWith(".AppImage"))] = outside;
  expectFailure(
    () =>
      stageArtifacts({
        root,
        platform: "linux-x86_64",
        target: CASES["linux-x86_64"].target,
        version: VERSION,
        commit: COMMIT,
        artifactPaths: outsidePaths,
        output: join(root, "outside-output"),
      }),
    /outside src-tauri\/target/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("release contract self-check passed");
