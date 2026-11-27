#!/usr/bin/env node
/**
 * Proves the dashboard runs the fork-local strict engine built from THIS commit
 * (strict in-place migration contract, item 4). Fails closed on any doubt.
 *
 *  1. package.json and package-lock.json both pin `hevy2garmin` to
 *     `file:../typescript` (never the npm registry, never a symlink: .npmrc
 *     sets install-links=true so peer dependencies resolve from web/).
 *  2. The installed copy is the private fork variant, not an upstream release.
 *  3. Its build stamp equals the digest of ../typescript/src (+ manifests) as
 *     they are now, so a stale or foreign dist cannot pass.
 *  4. When ../typescript/dist exists, every installed dist file is byte-equal.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const engineSrc = join(web, "..", "typescript");
const installed = join(web, "node_modules", "hevy2garmin");
const problems = [];
const fail = (m) => problems.push(m);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkg = readJson(join(web, "package.json"));
const lock = readJson(join(web, "package-lock.json"));

if (pkg.dependencies?.hevy2garmin !== "file:../typescript") {
  fail(`package.json must depend on file:../typescript, found ${pkg.dependencies?.hevy2garmin}`);
}
if (lock.packages?.[""]?.dependencies?.hevy2garmin !== "file:../typescript") {
  fail("package-lock.json root does not pin hevy2garmin to file:../typescript");
}
const locked = lock.packages?.["node_modules/hevy2garmin"];
if (!locked || locked.resolved !== "file:../typescript" || locked.link) {
  fail(`package-lock.json must install a copy resolved from file:../typescript, found ${JSON.stringify(locked?.resolved)}`);
}
const sourceVersion = readJson(join(engineSrc, "package.json")).version;
if (locked && locked.version !== sourceVersion) {
  fail(`package-lock.json records engine ${locked.version}, typescript/ is ${sourceVersion}; regenerate the lockfile`);
}
if (!/^\s*install-links\s*=\s*true\s*$/m.test(readFileSync(join(web, ".npmrc"), "utf8"))) {
  fail(".npmrc must set install-links=true");
}

if (!existsSync(join(installed, "package.json"))) {
  fail("node_modules/hevy2garmin is not installed; run npm ci in typescript/ (build) and web/");
} else {
  const ipkg = readJson(join(installed, "package.json"));
  const spkg = readJson(join(engineSrc, "package.json"));
  if (ipkg.private !== true || ipkg.version !== spkg.version) {
    fail(`installed engine ${ipkg.version} (private=${ipkg.private}) is not the fork engine ${spkg.version}`);
  }
  const stampPath = join(installed, "dist", "ENGINE_SOURCE_SHA256");
  const { sourceDigest } = await import(pathToFileURL(join(engineSrc, "scripts", "engine-stamp.mjs")).href);
  const expected = sourceDigest(engineSrc);
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "(missing)";
  if (stamp !== expected) {
    fail(`installed engine stamp ${stamp} != source digest ${expected}; rebuild typescript/ then reinstall web/`);
  }
  const builtDist = join(engineSrc, "dist");
  if (existsSync(builtDist)) {
    const files = (d) =>
      readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(d, join(e.parentPath ?? e.path, e.name)))
        .sort();
    const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const a = files(builtDist);
    const b = files(join(installed, "dist"));
    if (a.join("\n") !== b.join("\n")) fail("installed dist file list differs from typescript/dist");
    else for (const f of a) if (sha(join(builtDist, f)) !== sha(join(installed, "dist", f))) fail(`dist/${f} differs`);
  }
}

if (problems.length) {
  console.error("Engine identity check FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("Engine identity verified: fork-local strict engine, built from this commit's typescript/ source.");
