import { createHash, createPublicKey, verify as verifyCryptographicSignature } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(SCRIPT_PATH));
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PLATFORM_TARGETS = {
  "macos-aarch64": "aarch64-apple-darwin",
  "macos-x86_64": "x86_64-apple-darwin",
  "linux-x86_64": "x86_64-unknown-linux-gnu",
  "windows-x86_64": "x86_64-pc-windows-msvc",
};

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    requireValue(argument.startsWith("--"), `unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    requireValue(value && !value.startsWith("--"), `${argument} requires a value`);
    requireValue(values[key] === undefined, `${argument} was provided more than once`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function requiredArgument(arguments_, name) {
  const value = arguments_[name];
  requireValue(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read JSON from ${path}: ${error.message}`);
  }
}

function hashFile(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function fileDescription(path) {
  const status = lstatSync(path);
  requireValue(status.isFile(), `${path} is not a regular file`);
  requireValue(!status.isSymbolicLink(), `${path} must not be a symbolic link`);
  requireValue(status.size > 0, `${path} is empty`);
  return { size: status.size, sha256: hashFile(path) };
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function command(root, executable, arguments_, options = {}) {
  return execFileSync(executable, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function packageVersionFromCargoToml(contents) {
  const packageHeading = contents.match(/^\[package\]\s*$/m);
  requireValue(packageHeading?.index !== undefined, "src-tauri/Cargo.toml has no package section");
  const sectionStart = packageHeading.index + packageHeading[0].length;
  const remaining = contents.slice(sectionStart);
  const nextHeading = remaining.search(/^\[/m);
  const packageSection = nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  requireValue(version, "src-tauri/Cargo.toml has no package version");
  return version;
}

function packageVersionFromCargoLock(contents) {
  const packages = contents
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      name: block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1],
      version: block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
    }))
    .filter((entry) => entry.name === "desktop");
  requireValue(packages.length === 1, "src-tauri/Cargo.lock must contain one desktop package");
  requireValue(packages[0].version, "the desktop package in Cargo.lock has no version");
  return packages[0].version;
}

export function readRepositoryVersions(root = REPOSITORY_ROOT) {
  const packageJson = readJson(join(root, "package.json"));
  const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json"));
  return {
    "package.json": packageJson.version,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src-tauri/Cargo.toml": packageVersionFromCargoToml(
      readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8"),
    ),
    "src-tauri/Cargo.lock": packageVersionFromCargoLock(
      readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8"),
    ),
  };
}

function versionFromTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  requireValue(match, `release tag must match vMAJOR.MINOR.PATCH: ${tag}`);
  return match.slice(1).join(".");
}

function assertVersionsMatchTag(versions, tag) {
  const version = versionFromTag(tag);
  for (const [source, actual] of Object.entries(versions)) {
    requireValue(
      actual === version,
      `${source} has version ${String(actual)}, expected ${version} from ${tag}`,
    );
  }
  return version;
}

export function assertVersionContract(root, tag) {
  return assertVersionsMatchTag(readRepositoryVersions(root), tag);
}

function expectedUpdaterEndpoint(repository) {
  return `https://github.com/${repository}/releases/latest/download/latest.json`;
}

function assertRepositoryName(repository) {
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    `invalid repository: ${repository}`,
  );
}

function assertUpdaterEndpoint(tauriConfig, repository) {
  const endpoints = tauriConfig.plugins?.updater?.endpoints;
  requireValue(Array.isArray(endpoints), "Tauri updater endpoints are missing");
  requireValue(
    endpoints.includes(expectedUpdaterEndpoint(repository)),
    `release repository ${repository} does not match the configured updater endpoint`,
  );
}

export function assertReleaseRepository(root, repository) {
  assertRepositoryName(repository);
  const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json"));
  assertUpdaterEndpoint(tauriConfig, repository);
}

export function validateReleaseReference({
  root = REPOSITORY_ROOT,
  tag,
  expectedSha = "",
  defaultBranch,
  repository,
}) {
  versionFromTag(tag);
  assertRepositoryName(repository);
  requireValue(defaultBranch && !defaultBranch.includes(".."), "default branch is invalid");
  command(root, "git", ["check-ref-format", "--branch", defaultBranch]);

  const sha = command(root, "git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  requireValue(COMMIT_PATTERN.test(sha), `tag ${tag} did not resolve to a commit`);
  if (expectedSha) {
    requireValue(COMMIT_PATTERN.test(expectedSha), "expected commit is invalid");
    requireValue(sha === expectedSha, `tag ${tag} resolves to ${sha}, expected ${expectedSha}`);
  }

  const defaultRef = `refs/remotes/origin/${defaultBranch}`;
  const defaultSha = command(root, "git", ["rev-parse", "--verify", `${defaultRef}^{commit}`]);
  requireValue(COMMIT_PATTERN.test(defaultSha), `${defaultRef} did not resolve to a commit`);
  try {
    command(root, "git", ["merge-base", "--is-ancestor", sha, defaultSha]);
  } catch {
    fail(`tag ${tag} is not reachable from ${defaultRef}`);
  }

  const packageJsonContents = command(root, "git", ["show", `${sha}:package.json`]);
  const tauriConfigContents = command(root, "git", ["show", `${sha}:src-tauri/tauri.conf.json`]);
  const cargoTomlContents = command(root, "git", ["show", `${sha}:src-tauri/Cargo.toml`]);
  const cargoLockContents = command(root, "git", ["show", `${sha}:src-tauri/Cargo.lock`]);
  const tauriConfig = JSON.parse(tauriConfigContents);
  const version = assertVersionsMatchTag(
    {
      "package.json": JSON.parse(packageJsonContents).version,
      "src-tauri/tauri.conf.json": tauriConfig.version,
      "src-tauri/Cargo.toml": packageVersionFromCargoToml(cargoTomlContents),
      "src-tauri/Cargo.lock": packageVersionFromCargoLock(cargoLockContents),
    },
    tag,
  );
  assertUpdaterEndpoint(tauriConfig, repository);

  const commitDate = command(root, "git", ["show", "-s", "--format=%cI", sha]);
  const parsedDate = new Date(commitDate);
  requireValue(!Number.isNaN(parsedDate.valueOf()), `commit ${sha} has an invalid timestamp`);
  return { tag, version, sha, pubDate: parsedDate.toISOString() };
}

function rule(role, inputPattern, options = {}) {
  return {
    role,
    inputPattern,
    releasePattern: options.releasePattern ?? inputPattern,
    releaseName: options.releaseName,
    required: options.required ?? false,
  };
}

function platformRules(platform, version) {
  const escapedVersion = escapeRegularExpression(version);
  if (platform === "macos-aarch64" || platform === "macos-x86_64") {
    const artifactArch = platform === "macos-aarch64" ? "aarch64" : "x64";
    const escapedArch = escapeRegularExpression(artifactArch);
    return [
      rule(
        "dmg",
        new RegExp(`^Capptivo_${escapedVersion}_${escapedArch}\\.dmg$`),
        { required: true },
      ),
      rule("app", /^Capptivo\.app\.tar\.gz$/, {
        required: true,
        releaseName: `Capptivo_${version}_${artifactArch}.app.tar.gz`,
        releasePattern: new RegExp(
          `^Capptivo_${escapedVersion}_${escapedArch}\\.app\\.tar\\.gz$`,
        ),
      }),
    ];
  }

  if (platform === "linux-x86_64") {
    return [
      rule("deb", new RegExp(`^Capptivo_${escapedVersion}_amd64\\.deb$`), {
        required: true,
      }),
      rule("rpm", new RegExp(`^Capptivo-${escapedVersion}-1\\.x86_64\\.rpm$`), {
        required: true,
      }),
      rule("appimage", new RegExp(`^Capptivo_${escapedVersion}_amd64\\.AppImage$`), {
        required: true,
      }),
    ];
  }

  if (platform === "windows-x86_64") {
    return [
      rule("msi", new RegExp(`^Capptivo_${escapedVersion}_x64_en-US\\.msi$`), {
        required: true,
      }),
      rule("nsis", new RegExp(`^Capptivo_${escapedVersion}_x64-setup\\.exe$`), {
        required: true,
      }),
    ];
  }

  fail(`unsupported release platform: ${platform}`);
}

function validateRoleSet(rules, byRole, platform) {
  for (const entry of rules) {
    if (entry.required) {
      requireValue(byRole.has(entry.role), `${platform} is missing ${entry.role}`);
    }
  }
}

function validateReleaseIdentity({ platform, target, version, commit }) {
  requireValue(PLATFORM_TARGETS[platform], `unsupported release platform: ${platform}`);
  requireValue(
    target === PLATFORM_TARGETS[platform],
    `${platform} requires target ${PLATFORM_TARGETS[platform]}, received ${target}`,
  );
  requireValue(RELEASE_TAG_PATTERN.test(`v${version}`), `invalid release version: ${version}`);
  requireValue(COMMIT_PATTERN.test(commit), `invalid release commit: ${commit}`);
}

function discoverArtifactPaths(root, platform, target, version) {
  const bundleRoot = join(root, "src-tauri", "target", target, "release", "bundle");
  requireValue(existsSync(bundleRoot), `bundle directory does not exist: ${bundleRoot}`);
  const rules = platformRules(platform, version);
  const matches = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(".app")) visit(path);
        continue;
      }
      if (rules.some((candidate) => candidate.inputPattern.test(entry.name))) {
        matches.push(path);
      }
    }
  }

  visit(bundleRoot);
  return matches;
}

export function stageArtifacts({
  root = REPOSITORY_ROOT,
  platform,
  target,
  version,
  commit,
  artifactPaths,
  output,
}) {
  validateReleaseIdentity({ platform, target, version, commit });
  const paths = artifactPaths ?? discoverArtifactPaths(root, platform, target, version);
  requireValue(Array.isArray(paths) && paths.length > 0, "artifact path list is empty");
  requireValue(!existsSync(output), `stage output already exists: ${output}`);

  const targetRoot = realpathSync(
    join(root, "src-tauri", "target", target, "release", "bundle"),
  );
  const rules = platformRules(platform, version);
  const byRole = new Map();
  const sourcePaths = new Set();

  for (const artifactPath of paths) {
    requireValue(typeof artifactPath === "string" && artifactPath.length > 0, "artifact path is invalid");
    const absolutePath = resolve(root, artifactPath);
    const status = lstatSync(absolutePath);
    requireValue(!status.isSymbolicLink(), `${artifactPath} must not be a symbolic link`);
    const realPath = realpathSync(absolutePath);
    requireValue(isInside(targetRoot, realPath), `${artifactPath} is outside src-tauri/target`);
    requireValue(!sourcePaths.has(realPath), `duplicate artifact path: ${artifactPath}`);
    sourcePaths.add(realPath);

    if (status.isDirectory()) {
      requireValue(
        platform.startsWith("macos-") && basename(realPath) === "Capptivo.app",
        `unexpected artifact directory: ${artifactPath}`,
      );
      continue;
    }
    requireValue(status.isFile(), `${artifactPath} is not a regular file`);

    const inputName = basename(realPath);
    const matchingRules = rules.filter((entry) => entry.inputPattern.test(inputName));
    requireValue(matchingRules.length === 1, `unexpected ${platform} artifact: ${inputName}`);
    const matchingRule = matchingRules[0];
    requireValue(!byRole.has(matchingRule.role), `${platform} has duplicate ${matchingRule.role} artifacts`);
    byRole.set(matchingRule.role, {
      role: matchingRule.role,
      source: realPath,
      name: matchingRule.releaseName ?? inputName,
    });
  }

  validateRoleSet(rules, byRole, platform);
  const names = new Set();
  for (const asset of byRole.values()) {
    requireValue(SAFE_ASSET_NAME_PATTERN.test(asset.name), `unsafe release asset name: ${asset.name}`);
    requireValue(!names.has(asset.name), `duplicate release asset name: ${asset.name}`);
    names.add(asset.name);
  }

  mkdirSync(output, { recursive: true });
  const assets = [];
  for (const asset of [...byRole.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const destination = join(output, asset.name);
    copyFileSync(asset.source, destination);
    const description = fileDescription(destination);
    assets.push({
      name: asset.name,
      role: asset.role,
      size: description.size,
      sha256: description.sha256,
    });
  }

  const manifest = {
    schemaVersion: 1,
    platform,
    target,
    version,
    commit,
    assets,
  };
  writeFileSync(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function verifyStageDirectory({ directory, platform, version, commit }) {
  const manifestPath = join(directory, "release-manifest.json");
  const manifest = readJson(manifestPath);
  validateReleaseIdentity({
    platform: manifest.platform,
    target: manifest.target,
    version: manifest.version,
    commit: manifest.commit,
  });
  requireValue(manifest.schemaVersion === 1, `${platform} has an unsupported manifest schema`);
  requireValue(manifest.platform === platform, `${platform} manifest identifies ${manifest.platform}`);
  requireValue(manifest.version === version, `${platform} manifest has the wrong version`);
  requireValue(manifest.commit === commit, `${platform} manifest has the wrong commit`);
  requireValue(Array.isArray(manifest.assets), `${platform} manifest has no asset list`);

  const rules = platformRules(platform, version);
  const rulesByRole = new Map(rules.map((entry) => [entry.role, entry]));
  const byRole = new Map();
  const expectedFiles = new Set(["release-manifest.json"]);
  for (const asset of manifest.assets) {
    requireValue(asset && typeof asset === "object", `${platform} has an invalid asset entry`);
    requireValue(SAFE_ASSET_NAME_PATTERN.test(asset.name), `${platform} has an unsafe asset name`);
    const matchingRule = rulesByRole.get(asset.role);
    requireValue(matchingRule, `${platform} has an unknown asset role: ${asset.role}`);
    requireValue(
      matchingRule.releasePattern.test(asset.name),
      `${platform} has the wrong name for ${asset.role}: ${asset.name}`,
    );
    requireValue(!byRole.has(asset.role), `${platform} manifest repeats ${asset.role}`);
    requireValue(!expectedFiles.has(asset.name), `${platform} manifest repeats ${asset.name}`);
    requireValue(Number.isSafeInteger(asset.size) && asset.size > 0, `${asset.name} has an invalid size`);
    requireValue(/^[0-9a-f]{64}$/.test(asset.sha256), `${asset.name} has an invalid SHA-256`);

    const path = join(directory, asset.name);
    const description = fileDescription(path);
    requireValue(description.size === asset.size, `${asset.name} size does not match its manifest`);
    requireValue(description.sha256 === asset.sha256, `${asset.name} hash does not match its manifest`);
    expectedFiles.add(asset.name);
    byRole.set(asset.role, { ...asset, path, platform });
  }
  validateRoleSet(rules, byRole, platform);

  const actualFiles = readdirSync(directory, { withFileTypes: true });
  for (const entry of actualFiles) {
    requireValue(entry.isFile() && !entry.isSymbolicLink(), `${platform} contains a non-file entry: ${entry.name}`);
  }
  const actualNames = new Set(actualFiles.map((entry) => entry.name));
  requireValue(actualNames.size === expectedFiles.size, `${platform} stage contains unexpected files`);
  for (const expected of expectedFiles) {
    requireValue(actualNames.has(expected), `${platform} stage is missing ${expected}`);
  }
  return byRole;
}

function updaterEntry(asset, signaturePath, repository, tag) {
  const signatureContents = readFileSync(signaturePath, "utf8");
  requireValue(
    signatureContents.length > 0 && signatureContents.length <= 65_536,
    `${basename(signaturePath)} is invalid`,
  );
  requireValue(!signatureContents.includes("\0"), `${basename(signaturePath)} contains a null byte`);
  return {
    signature: signatureContents,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
  };
}

function decodeBase64(value, label) {
  const encoded = value.trim();
  requireValue(
    encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    `${label} is not canonical base64`,
  );
  const decoded = Buffer.from(encoded, "base64");
  requireValue(decoded.toString("base64") === encoded, `${label} is not canonical base64`);
  return decoded;
}

function updaterPublicKey(root) {
  const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json"));
  const encodedPublicKey = tauriConfig.plugins?.updater?.pubkey;
  requireValue(typeof encodedPublicKey === "string", "Tauri updater public key is missing");
  const publicKeyText = decodeBase64(encodedPublicKey, "Tauri updater public key").toString("utf8");
  const lines = publicKeyText.trimEnd().split(/\r?\n/);
  requireValue(lines.length === 2, "Tauri updater public key has the wrong line count");
  requireValue(
    lines[0].startsWith("untrusted comment: minisign public key: "),
    "Tauri updater public key has the wrong comment",
  );
  const packet = decodeBase64(lines[1], "Tauri updater public key packet");
  requireValue(packet.length === 42, "Tauri updater public key packet has the wrong size");
  requireValue(packet.subarray(0, 2).toString("ascii") === "Ed", "Tauri updater key algorithm is unsupported");
  const subjectPublicKeyInfo = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    packet.subarray(10),
  ]);
  try {
    return {
      id: packet.subarray(2, 10),
      key: createPublicKey({ key: subjectPublicKeyInfo, format: "der", type: "spki" }),
    };
  } catch (error) {
    fail(`Tauri updater public key is invalid: ${error.message}`);
  }
}

function validateUpdaterSignature(root, signaturePath, assetPath) {
  const assetName = basename(assetPath);
  const encodedSignature = readFileSync(signaturePath, "utf8");
  const signatureText = decodeBase64(encodedSignature, `${basename(signaturePath)} signature`).toString(
    "utf8",
  );
  const lines = signatureText.trimEnd().split(/\r?\n/);
  requireValue(lines.length === 4, `${basename(signaturePath)} has the wrong signature line count`);
  requireValue(
    lines[0] === "untrusted comment: signature from tauri secret key",
    `${basename(signaturePath)} has the wrong signature comment`,
  );
  const packet = decodeBase64(lines[1], `${basename(signaturePath)} signature packet`);
  requireValue(packet.length === 74, `${basename(signaturePath)} signature packet has the wrong size`);
  requireValue(packet.subarray(0, 2).toString("ascii") === "ED", "updater signature algorithm is unsupported");
  const publicKey = updaterPublicKey(root);
  requireValue(
    packet.subarray(2, 10).equals(publicKey.id),
    `${basename(signaturePath)} does not match the configured updater public key`,
  );
  const escapedAssetName = escapeRegularExpression(assetName);
  requireValue(
    new RegExp(`^trusted comment: timestamp:[0-9]+\\tfile:${escapedAssetName}$`).test(lines[2]),
    `${basename(signaturePath)} has the wrong trusted comment`,
  );
  const trustedCommentSignature = decodeBase64(
    lines[3],
    `${basename(signaturePath)} trusted comment signature`,
  );
  requireValue(
    trustedCommentSignature.length === 64,
    `${basename(signaturePath)} trusted comment signature has the wrong size`,
  );
  const signature = packet.subarray(10);
  const digest = createHash("blake2b512").update(readFileSync(assetPath)).digest();
  requireValue(
    verifyCryptographicSignature(null, digest, publicKey.key, signature),
    `${basename(signaturePath)} does not authenticate ${assetName}`,
  );
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  requireValue(
    verifyCryptographicSignature(
      null,
      globalMessage,
      publicKey.key,
      trustedCommentSignature,
    ),
    `${basename(signaturePath)} has an invalid trusted comment signature`,
  );
}

function checksumContents(directory, names) {
  return `${names
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${hashFile(join(directory, name))}  ${name}`)
    .join("\n")}\n`;
}

function writeChecksums(directory, names, outputName) {
  writeFileSync(join(directory, outputName), checksumContents(directory, names));
}

export function validateChecksumCoverage(contents, expectedNames) {
  requireValue(contents.endsWith("\n"), "checksum list must end with a newline");
  const expected = new Set(expectedNames);
  requireValue(expected.size === expectedNames.length, "expected checksum names contain a duplicate");
  const actual = new Set();
  for (const line of contents.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    requireValue(match, `invalid checksum line: ${line}`);
    const name = match[2];
    requireValue(expected.has(name), `checksum list contains unexpected file: ${name}`);
    requireValue(!actual.has(name), `checksum list repeats ${name}`);
    actual.add(name);
  }
  for (const name of expected) {
    requireValue(actual.has(name), `checksum list is missing ${name}`);
  }
  return actual;
}

export function validateChecksums(directory, contents, expectedNames) {
  validateChecksumCoverage(contents, expectedNames);
  for (const line of contents.trimEnd().split("\n")) {
    const [expectedHash, name] = line.split("  ");
    requireValue(hashFile(join(directory, name)) === expectedHash, `${name} checksum does not match`);
  }
}

function validateReleaseMetadata({ root, tag, version, commit, pubDate, repository }) {
  requireValue(assertVersionContract(root, tag) === version, "tag and version do not match");
  assertReleaseRepository(root, repository);
  requireValue(COMMIT_PATTERN.test(commit), `invalid release commit: ${commit}`);
  requireValue(new Date(pubDate).toISOString() === pubDate, `invalid publication date: ${pubDate}`);
}

export function assembleUnsignedRelease({
  root = REPOSITORY_ROOT,
  stagedRoot,
  output,
  notesPath,
  tag,
  version,
  commit,
  pubDate,
  repository,
}) {
  requireValue(!existsSync(output), `verified output already exists: ${output}`);
  validateReleaseMetadata({ root, tag, version, commit, pubDate, repository });

  const platformAssets = new Map();
  for (const platform of Object.keys(PLATFORM_TARGETS)) {
    const directory = join(stagedRoot, `release-${platform}`);
    requireValue(existsSync(directory), `missing staged artifact: release-${platform}`);
    platformAssets.set(
      platform,
      verifyStageDirectory({ directory, platform, version, commit }),
    );
  }

  const stagedEntries = readdirSync(stagedRoot, { withFileTypes: true });
  const expectedStageNames = new Set(
    Object.keys(PLATFORM_TARGETS).map((platform) => `release-${platform}`),
  );
  requireValue(stagedEntries.length === expectedStageNames.size, "staged root contains unexpected entries");
  for (const entry of stagedEntries) {
    requireValue(entry.isDirectory(), `staged root contains a non-directory entry: ${entry.name}`);
    requireValue(expectedStageNames.has(entry.name), `staged root contains ${entry.name}`);
  }

  const notes = readFileSync(notesPath, "utf8");
  requireValue(notes.trim().length > 0, "release notes are empty");
  requireValue(!notes.includes("\0"), "release notes contain a null byte");

  const payload = join(output, "payload");
  mkdirSync(payload, { recursive: true });
  const unsignedAssets = [];
  const publishedNames = new Set();
  for (const [platform, assets] of platformAssets) {
    for (const asset of assets.values()) {
      requireValue(!publishedNames.has(asset.name), `release asset name is not unique: ${asset.name}`);
      publishedNames.add(asset.name);
      copyFileSync(asset.path, join(payload, asset.name));
      unsignedAssets.push({
        name: asset.name,
        role: asset.role,
        platform,
        size: asset.size,
        sha256: asset.sha256,
      });
    }
  }

  unsignedAssets.sort((left, right) => left.name.localeCompare(right.name));
  const manifest = {
    schemaVersion: 1,
    tag,
    version,
    commit,
    pubDate,
    repository,
    assets: unsignedAssets,
  };
  writeFileSync(join(output, "unsigned-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, "release-notes.md"), notes);
  const verificationNames = [
    "release-notes.md",
    "unsigned-manifest.json",
    ...[...publishedNames].map((name) => `payload/${name}`),
  ];
  writeFileSync(join(output, "unsigned.sha256"), checksumContents(output, verificationNames));
  return manifest;
}

function verifyUnsignedRelease({
  root,
  unsignedRoot,
  tag,
  version,
  commit,
  pubDate,
  repository,
  allowSignatures,
}) {
  validateReleaseMetadata({ root, tag, version, commit, pubDate, repository });
  const manifest = readJson(join(unsignedRoot, "unsigned-manifest.json"));
  requireValue(manifest.schemaVersion === 1, "unsigned manifest has an unsupported schema");
  for (const [name, expected] of Object.entries({ tag, version, commit, pubDate, repository })) {
    requireValue(manifest[name] === expected, `unsigned manifest has the wrong ${name}`);
  }
  requireValue(Array.isArray(manifest.assets), "unsigned manifest has no asset list");

  const payload = join(unsignedRoot, "payload");
  const names = new Set();
  const assets = new Map();
  const rolesByPlatform = new Map(
    Object.keys(PLATFORM_TARGETS).map((platform) => [platform, new Map()]),
  );
  for (const asset of manifest.assets) {
    requireValue(asset && typeof asset === "object", "unsigned manifest has an invalid asset entry");
    requireValue(SAFE_ASSET_NAME_PATTERN.test(asset.name), `unsafe unsigned asset name: ${asset.name}`);
    requireValue(!names.has(asset.name), `unsigned manifest repeats ${asset.name}`);
    requireValue(Object.hasOwn(PLATFORM_TARGETS, asset.platform), `unknown asset platform: ${asset.platform}`);
    const rule = platformRules(asset.platform, version).find((candidate) => candidate.role === asset.role);
    requireValue(rule?.releasePattern.test(asset.name), `invalid ${asset.platform} ${asset.role} asset`);
    requireValue(Number.isSafeInteger(asset.size) && asset.size > 0, `${asset.name} has an invalid size`);
    requireValue(/^[0-9a-f]{64}$/.test(asset.sha256), `${asset.name} has an invalid SHA-256`);
    const description = fileDescription(join(payload, asset.name));
    requireValue(description.size === asset.size, `${asset.name} size does not match its manifest`);
    requireValue(description.sha256 === asset.sha256, `${asset.name} hash does not match its manifest`);
    names.add(asset.name);
    assets.set(`${asset.platform}:${asset.role}`, { ...asset, path: join(payload, asset.name) });
    rolesByPlatform.get(asset.platform).set(asset.role, asset);
  }
  for (const [platform, byRole] of rolesByPlatform) {
    validateRoleSet(platformRules(platform, version), byRole, platform);
  }

  const expectedRootNames = new Set([
    "payload",
    "release-notes.md",
    "unsigned-manifest.json",
    "unsigned.sha256",
  ]);
  const rootEntries = readdirSync(unsignedRoot, { withFileTypes: true });
  requireValue(rootEntries.length === expectedRootNames.size, "unsigned release contains unexpected entries");
  for (const entry of rootEntries) {
    requireValue(expectedRootNames.has(entry.name), `unsigned release contains ${entry.name}`);
    requireValue(!entry.isSymbolicLink(), `unsigned release contains a symbolic link: ${entry.name}`);
    requireValue(
      entry.name === "payload" ? entry.isDirectory() : entry.isFile(),
      `unsigned release has the wrong entry type for ${entry.name}`,
    );
  }

  const signatureNames = new Set(
    [
      "macos-aarch64:app",
      "macos-x86_64:app",
      "linux-x86_64:deb",
      "linux-x86_64:rpm",
      "linux-x86_64:appimage",
      "windows-x86_64:msi",
      "windows-x86_64:nsis",
    ].map((key) => `${assets.get(key)?.name}.sig`),
  );
  requireValue(!signatureNames.has("undefined.sig"), "unsigned release is missing an updater asset");
  const payloadEntries = readdirSync(payload, { withFileTypes: true });
  for (const entry of payloadEntries) {
    requireValue(entry.isFile() && !entry.isSymbolicLink(), `payload contains a non-file entry: ${entry.name}`);
    requireValue(
      names.has(entry.name) || (allowSignatures && signatureNames.has(entry.name)),
      `payload contains unexpected file: ${entry.name}`,
    );
  }
  const expectedPayloadCount = names.size + (allowSignatures ? signatureNames.size : 0);
  requireValue(payloadEntries.length === expectedPayloadCount, "payload has a missing or duplicate file");

  const verificationNames = [
    "release-notes.md",
    "unsigned-manifest.json",
    ...[...names].map((name) => `payload/${name}`),
  ];
  requireValue(
    readFileSync(join(unsignedRoot, "unsigned.sha256"), "utf8") ===
      checksumContents(unsignedRoot, verificationNames),
    "unsigned release checksum list does not match",
  );
  return { manifest, assets, signatureNames };
}

export function validateUnsignedRelease(options) {
  return verifyUnsignedRelease({ ...options, allowSignatures: false });
}

export function finalizeSignedRelease({
  root = REPOSITORY_ROOT,
  unsignedRoot,
  output,
  tag,
  version,
  commit,
  pubDate,
  repository,
}) {
  requireValue(!existsSync(output), `signed output already exists: ${output}`);
  const verified = verifyUnsignedRelease({
    root,
    unsignedRoot,
    tag,
    version,
    commit,
    pubDate,
    repository,
    allowSignatures: true,
  });
  const unsignedPayload = join(unsignedRoot, "payload");
  const payload = join(output, "payload");
  mkdirSync(payload, { recursive: true });
  const publishedAssets = [];
  for (const asset of verified.manifest.assets) {
    copyFileSync(join(unsignedPayload, asset.name), join(payload, asset.name));
    publishedAssets.push({
      name: asset.name,
      role: asset.role,
      platform: asset.platform,
      size: asset.size,
      sha256: asset.sha256,
    });
  }
  for (const signatureName of verified.signatureNames) {
    const source = join(unsignedPayload, signatureName);
    const assetPath = join(unsignedPayload, signatureName.slice(0, -4));
    validateUpdaterSignature(root, source, assetPath);
    const description = fileDescription(source);
    copyFileSync(source, join(payload, signatureName));
    const owner = verified.manifest.assets.find((asset) => `${asset.name}.sig` === signatureName);
    publishedAssets.push({
      name: signatureName,
      role: `${owner.role}-signature`,
      platform: owner.platform,
      size: description.size,
      sha256: description.sha256,
    });
  }

  const asset = (platform, role) => verified.assets.get(`${platform}:${role}`);
  const signature = (platform, role) => `${asset(platform, role).path}.sig`;
  const macArmUpdater = updaterEntry(
    asset("macos-aarch64", "app"),
    signature("macos-aarch64", "app"),
    repository,
    tag,
  );
  const macX64Updater = updaterEntry(
    asset("macos-x86_64", "app"),
    signature("macos-x86_64", "app"),
    repository,
    tag,
  );
  const linuxDebUpdater = updaterEntry(
    asset("linux-x86_64", "deb"),
    signature("linux-x86_64", "deb"),
    repository,
    tag,
  );
  const linuxRpmUpdater = updaterEntry(
    asset("linux-x86_64", "rpm"),
    signature("linux-x86_64", "rpm"),
    repository,
    tag,
  );
  const linuxAppImageUpdater = updaterEntry(
    asset("linux-x86_64", "appimage"),
    signature("linux-x86_64", "appimage"),
    repository,
    tag,
  );
  const windowsMsiUpdater = updaterEntry(
    asset("windows-x86_64", "msi"),
    signature("windows-x86_64", "msi"),
    repository,
    tag,
  );
  const windowsNsisUpdater = updaterEntry(
    asset("windows-x86_64", "nsis"),
    signature("windows-x86_64", "nsis"),
    repository,
    tag,
  );
  const latest = {
    version,
    notes: readFileSync(join(unsignedRoot, "release-notes.md"), "utf8"),
    pub_date: pubDate,
    platforms: {
      "darwin-aarch64": macArmUpdater,
      "darwin-aarch64-app": macArmUpdater,
      "darwin-x86_64": macX64Updater,
      "darwin-x86_64-app": macX64Updater,
      "linux-x86_64": linuxAppImageUpdater,
      "linux-x86_64-appimage": linuxAppImageUpdater,
      "linux-x86_64-deb": linuxDebUpdater,
      "linux-x86_64-rpm": linuxRpmUpdater,
      "windows-x86_64": windowsMsiUpdater,
      "windows-x86_64-msi": windowsMsiUpdater,
      "windows-x86_64-nsis": windowsNsisUpdater,
    },
  };
  writeFileSync(join(payload, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  const latestDescription = fileDescription(join(payload, "latest.json"));
  publishedAssets.push({
    name: "latest.json",
    role: "updater-metadata",
    platform: "all",
    size: latestDescription.size,
    sha256: latestDescription.sha256,
  });

  publishedAssets.sort((left, right) => left.name.localeCompare(right.name));
  const manifest = {
    schemaVersion: 1,
    tag,
    version,
    commit,
    pubDate,
    repository,
    assets: publishedAssets,
  };
  writeFileSync(join(payload, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeChecksums(
    payload,
    [...publishedAssets.map((entry) => entry.name), "release-manifest.json"],
    "SHA256SUMS",
  );
  validateChecksums(
    payload,
    readFileSync(join(payload, "SHA256SUMS"), "utf8"),
    [...publishedAssets.map((entry) => entry.name), "release-manifest.json"],
  );
  copyFileSync(join(unsignedRoot, "release-notes.md"), join(output, "release-notes.md"));

  const payloadNames = readdirSync(payload).map((name) => `payload/${name}`);
  const verifiedNames = ["release-notes.md", ...payloadNames];
  const verificationContents = verifiedNames
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${hashFile(join(output, ...name.split("/")))}  ${name}`)
    .join("\n");
  writeFileSync(join(output, "verified.sha256"), `${verificationContents}\n`);
  return manifest;
}

function main() {
  const [operation, ...rest] = process.argv.slice(2);
  const arguments_ = parseArguments(rest);
  if (operation === "validate") {
    const result = validateReleaseReference({
      tag: requiredArgument(arguments_, "tag"),
      expectedSha: arguments_["expected-sha"] ?? "",
      defaultBranch: requiredArgument(arguments_, "default-branch"),
      repository: requiredArgument(arguments_, "repository"),
    });
    const output = requiredArgument(arguments_, "github-output");
    appendFileSync(
      output,
      `tag=${result.tag}\nversion=${result.version}\nsha=${result.sha}\npub_date=${result.pubDate}\n`,
    );
    return;
  }

  if (operation === "stage") {
    stageArtifacts({
      platform: requiredArgument(arguments_, "platform"),
      target: requiredArgument(arguments_, "target"),
      version: requiredArgument(arguments_, "version"),
      commit: requiredArgument(arguments_, "commit"),
      output: resolve(requiredArgument(arguments_, "output")),
    });
    return;
  }

  if (operation === "assemble-unsigned") {
    assembleUnsignedRelease({
      stagedRoot: resolve(requiredArgument(arguments_, "staged-root")),
      output: resolve(requiredArgument(arguments_, "output")),
      notesPath: resolve(requiredArgument(arguments_, "notes")),
      tag: requiredArgument(arguments_, "tag"),
      version: requiredArgument(arguments_, "version"),
      commit: requiredArgument(arguments_, "commit"),
      pubDate: requiredArgument(arguments_, "pub-date"),
      repository: requiredArgument(arguments_, "repository"),
    });
    return;
  }

  if (operation === "finalize") {
    finalizeSignedRelease({
      unsignedRoot: resolve(requiredArgument(arguments_, "unsigned-root")),
      output: resolve(requiredArgument(arguments_, "output")),
      tag: requiredArgument(arguments_, "tag"),
      version: requiredArgument(arguments_, "version"),
      commit: requiredArgument(arguments_, "commit"),
      pubDate: requiredArgument(arguments_, "pub-date"),
      repository: requiredArgument(arguments_, "repository"),
    });
    return;
  }

  if (operation === "verify-unsigned") {
    validateUnsignedRelease({
      unsignedRoot: resolve(requiredArgument(arguments_, "unsigned-root")),
      tag: requiredArgument(arguments_, "tag"),
      version: requiredArgument(arguments_, "version"),
      commit: requiredArgument(arguments_, "commit"),
      pubDate: requiredArgument(arguments_, "pub-date"),
      repository: requiredArgument(arguments_, "repository"),
      root: REPOSITORY_ROOT,
    });
    return;
  }

  fail("expected one of: validate, stage, assemble-unsigned, verify-unsigned, finalize");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    main();
  } catch (error) {
    console.error(`Release contract error: ${error.message}`);
    process.exitCode = 1;
  }
}
