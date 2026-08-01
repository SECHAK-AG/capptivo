/**
 * Runs every `src/**\/*.selfcheck.ts` and fails if any of them does.
 * Run: `node scripts/run-selfchecks.mjs` (or `pnpm test:selfcheck`)
 *
 * The repo's tests are dependency-free selfchecks: each file is a standalone
 * ES module that asserts at import time, prints `<name>.selfcheck: ok`, and
 * throws or exits non-zero otherwise. That design needs no framework — but it
 * does need something to actually run them, and until this script existed
 * nothing did. The suite had already started to rot: one selfcheck could not
 * execute at all because a dependency's relative import lost its `.ts`
 * extension, and nobody noticed.
 *
 * Each file runs in its own child process. Selfchecks assert at import time
 * and some set `process.exitCode`, so importing them all into one process
 * would let the first failure mask every file after it.
 *
 * Discovery is a directory walk rather than a glob so the script keeps the
 * zero-dependency property of the thing it runs. Finding no files exits 1:
 * a runner that silently matches nothing is worse than no runner, because it
 * reports green forever.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");

/** @returns {string[]} absolute paths to every selfcheck under `dir`, sorted. */
function findSelfchecks(dir) {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findSelfchecks(path));
    } else if (entry.isFile() && entry.name.endsWith(".selfcheck.ts")) {
      found.push(path);
    }
  }

  // Sorted so a diff of two runs is about the results, not the walk order.
  return found.sort();
}

const files = findSelfchecks(srcDir);

if (files.length === 0) {
  console.error(
    `no *.selfcheck.ts files found under ${relative(repoRoot, srcDir)} — ` +
      `the walk is broken, not the suite`,
  );
  process.exit(1);
}

let passed = 0;
const failed = [];

for (const file of files) {
  const name = relative(repoRoot, file);
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", file],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (run.status === 0) {
    passed += 1;
    continue;
  }

  // Output only for failures: 31 green lines bury the one that matters.
  failed.push(name);
  console.error(`\n✗ ${name}`);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd();
  if (output) {
    console.error(output.replace(/^/gm, "    "));
  }
  if (run.error) {
    console.error(`    could not spawn: ${run.error.message}`);
  }
}

console.log(
  `\nselfchecks: ${passed} passed, ${failed.length} failed` +
    ` (${files.length} discovered)`,
);

if (failed.length > 0) {
  process.exit(1);
}
