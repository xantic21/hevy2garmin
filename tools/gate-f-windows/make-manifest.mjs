#!/usr/bin/env node
/**
 * Writes tools/gate-f-windows/SOURCE_MANIFEST.sha256 (SHA-256 of every tracked
 * file under typescript/, web/ and tools/gate-f-windows/, except gate-f.cmd and
 * the manifest itself) and pins the manifest's and gate-f.mjs's hashes in
 * gate-f.cmd. Run it after any change in those folders and commit the result.
 *
 *   node tools/gate-f-windows/make-manifest.mjs           write
 *   node tools/gate-f-windows/make-manifest.mjs --check   fail when stale (CI)
 *
 * The hashes are over the bytes git stores, which are the bytes of GitHub's
 * source archive of the commit: the files must be committed and unmodified.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_PATH, SCOPES, UNLISTED, sha256 } from "./gate-f.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "buffer", maxBuffer: 1 << 30 });

const files = git("ls-files", "-z", "--", ...SCOPES.map((s) => s.replace(/\/$/, "")))
  .toString("utf8")
  .split("\0")
  .filter((p) => p && !UNLISTED.includes(p))
  .sort();
// The committed bytes (HEAD), so an uncommitted edit can never slip into the pins.
const lines = files.map((p) => `${sha256(git("show", `HEAD:${p}`))}  ${p}`);
const manifest = `${lines.join("\n")}\n`;
const launcher = files.includes("tools/gate-f-windows/gate-f.mjs") ? sha256(git("show", "HEAD:tools/gate-f-windows/gate-f.mjs")) : null;
if (!launcher) throw new Error("gate-f.mjs is not committed");

const cmdPath = join(repo, "tools", "gate-f-windows", "gate-f.cmd");
// --check compares the COMMITTED bytes (what the owner downloads), never a checkout that
// core.autocrlf may have rewritten; writing works on the working tree.
const committed = (p) => {
  try {
    return git("show", `HEAD:${p}`);
  } catch {
    return Buffer.alloc(0);
  }
};
const cmd = check ? committed("tools/gate-f-windows/gate-f.cmd").toString("latin1") : readFileSync(cmdPath, "latin1");
const pin = (text, name, value) => {
  const re = new RegExp(`(set "${name}=)[0-9a-f]{64}(")`);
  if (!re.test(text)) throw new Error(`gate-f.cmd has no pin ${name}`);
  return text.replace(re, `$1${value}$2`);
};
const nextCmd = pin(pin(cmd, "MANIFEST_SHA256", sha256(Buffer.from(manifest))), "LAUNCHER_SHA256", launcher);
const current = check
  ? committed(MANIFEST_PATH).toString("utf8")
  : (() => {
      try {
        return readFileSync(join(repo, MANIFEST_PATH), "utf8");
      } catch {
        return "";
      }
    })();

if (check) {
  const stale = [];
  if (current !== manifest) stale.push(MANIFEST_PATH);
  if (cmd !== nextCmd) stale.push("tools/gate-f-windows/gate-f.cmd pins");
  if (!/\r\n/.test(cmd) || /[^\r]\n/.test(cmd)) stale.push("tools/gate-f-windows/gate-f.cmd must use CRLF line endings");
  if (stale.length) {
    console.error(`stale: ${stale.join("; ")}. Run node tools/gate-f-windows/make-manifest.mjs and commit.`);
    process.exit(1);
  }
  console.log(`manifest current: ${files.length} files, manifest ${sha256(Buffer.from(manifest)).slice(0, 16)}…, launcher ${launcher.slice(0, 16)}…`);
} else {
  writeFileSync(join(repo, MANIFEST_PATH), manifest);
  writeFileSync(cmdPath, nextCmd, "latin1");
  console.log(`wrote ${MANIFEST_PATH} (${files.length} files) and the pins in gate-f.cmd`);
}
