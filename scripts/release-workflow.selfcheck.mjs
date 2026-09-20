import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
const unsignedConfig = JSON.parse(
  readFileSync(join(root, ".github", "tauri.unsigned.conf.json"), "utf8"),
);

assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
assert.doesNotMatch(workflow, /^\s{2}push:\s*$/m);
assert.equal(workflow.match(/^\s+contents: write\s*$/gm)?.length, 1);
assert.equal(workflow.match(/persist-credentials: false/g)?.length, 4);
assert.equal(workflow.match(/^\s{4}environment: release\s*$/gm)?.length, 2);
assert.doesNotMatch(workflow, /tauri-apps\/tauri-action/);

const actionReferences = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)].map(
  (match) => match[1],
);
assert.ok(actionReferences.length > 0);
for (const reference of actionReferences) {
  assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/);
}

const buildSection = workflow.split("\n  build:\n")[1].split("\n  verify:\n")[0];
const signSection = workflow.split("\n  sign:\n")[1].split("\n  publish:\n")[0];
const publishSection = workflow.split("\n  publish:\n")[1];
assert.doesNotMatch(buildSection, /TAURI_SIGNING_PRIVATE_KEY|contents: write/);
assert.equal(signSection.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY/g)?.length, 2);
assert.doesNotMatch(signSection, /contents: write|github\.token/);
assert.equal(signSection.match(/"\$signer" signer sign /g)?.length, 7);
for (const installer of ["amd64.deb", "x86_64.rpm", "amd64.AppImage", "en-US.msi", "setup.exe"]) {
  assert.match(signSection, new RegExp(installer.replaceAll(".", "\\.")));
}
assert.match(publishSection, /contents: write/);
assert.match(publishSection, /GH_TOKEN: \$\{\{ github\.token \}\}/);
assert.doesNotMatch(publishSection, /actions\/checkout|TAURI_SIGNING_PRIVATE_KEY/);
assert.equal(
  publishSection.match(/test "\$\(resolve_tag\)" = "\$RELEASE_SHA"/g)?.length,
  3,
);
assert.match(publishSection, /\.draft' <<<"\$release"\)" = "true"/);
assert.ok(
  publishSection.indexOf("sha256sum --check --strict SHA256SUMS") <
    publishSection.indexOf("GH_TOKEN: ${{ github.token }}"),
);

assert.equal(unsignedConfig.bundle?.createUpdaterArtifacts, false);

console.log("release workflow self-check passed");
