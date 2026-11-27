#!/usr/bin/env node
/**
 * Engine identity stamp (fork-only, strict in-place migration).
 *
 * `node scripts/engine-stamp.mjs write` (run by `npm run build`) records in
 * dist/ENGINE_SOURCE_SHA256 a digest of exactly the inputs the build compiled:
 * every file under src/, package.json, package-lock.json and tsconfig.json.
 *
 * `node scripts/engine-stamp.mjs digest [dir]` prints the digest of a source
 * tree without writing anything, so a consumer (web/scripts/verify-engine.mjs)
 * can prove the engine it installed was built from the source in this commit.
 *
 * The digest format is versioned ("h2g-engine-source-v1") so a future change
 * of the recipe can never be mistaken for a matching build.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECIPE = "h2g-engine-source-v1";
const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function sourceDigest(engineDir) {
  const files = [
    ...ROOT_FILES.map((f) => join(engineDir, f)),
    ...walk(join(engineDir, "src")),
  ].filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile());
  const lines = files
    .map((f) => relative(engineDir, f).split(sep).join("/"))
    .sort()
    .map((rel) => `${rel}\0${createHash("sha256").update(readFileSync(join(engineDir, rel))).digest("hex")}`);
  return createHash("sha256").update(`${RECIPE}\n${lines.join("\n")}\n`).digest("hex");
}

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [mode = "write", target] = invokedDirectly ? process.argv.slice(2) : ["library"];

if (mode === "library") {
  // Imported by web/scripts/verify-engine.mjs: export only, no side effects.
} else if (mode === "write") {
  mkdirSync(join(here, "dist"), { recursive: true });
  const digest = sourceDigest(here);
  writeFileSync(join(here, "dist", "ENGINE_SOURCE_SHA256"), `${digest}\n`);
  console.log(`engine source digest ${digest}`);
} else if (mode === "digest") {
  console.log(sourceDigest(target ?? here));
} else {
  console.error("usage: engine-stamp.mjs write|digest [engineDir]");
  process.exit(2);
}
