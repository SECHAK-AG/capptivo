/**
 * Node resolve hooks so the editor's TypeScript modules import under plain
 * `node --experimental-strip-types`: maps the `@/` alias onto `src/` and adds
 * the `.ts` / `/index.ts` suffix that Vite resolves implicitly.
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../..");
const srcDir = join(repoRoot, "src");

function withTsSuffix(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  if (existsSync(join(path, "index.ts"))) return join(path, "index.ts");
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const found = withTsSuffix(join(srcDir, specifier.slice(2)));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    const found = withTsSuffix(resolvePath(base, specifier));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }
  return nextResolve(specifier, context);
}
