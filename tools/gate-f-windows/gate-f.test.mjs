// node --test tools/gate-f-windows/   (Linux CI and locally; the Windows job runs the whole path)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanEnv, envFileText, isoSeconds, loopbackOnly, newSecrets, normalizeDatabaseUrl, parseEnvFile, parseManifest,
  parseNetstatListeners, parseProcNetListeners, savedAclOwnerOnly, sddlOwnerOnly, sha256, unsafeInherited, verifySource,
} from "./gate-f.mjs";

const NEON = "postgresql://owner:Secr3tPw@ep-cool-river-a1b2c3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

test("connection string: Neon only, every parameter dropped, verified TLS", () => {
  assert.equal(normalizeDatabaseUrl(NEON), "postgresql://owner:Secr3tPw@ep-cool-river-a1b2c3.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full");
  const once = normalizeDatabaseUrl(NEON);
  assert.equal(normalizeDatabaseUrl(once), once, "idempotent");
  for (const bad of [
    "mysql://u:p@ep-x.neon.tech/db",
    "postgresql://u:p@db.example.com/db",
    "postgresql://u:p@ep-x.neon.tech.evil.com/db",
    "postgresql://u@ep-x.neon.tech/db",
    "postgresql://u:p@ep-x.neon.tech/",
    "postgresql://u:p@127.0.0.1/db",
    "not a url",
  ]) assert.throws(() => normalizeDatabaseUrl(bad), /refusing/, bad);
});

test("connection string: the rehearsal accepts only this computer, without TLS", () => {
  assert.equal(normalizeDatabaseUrl("postgres://postgres:root@127.0.0.1/h2g", { rehearsal: true }), "postgres://postgres:root@127.0.0.1:5432/h2g?sslmode=disable");
  assert.throws(() => normalizeDatabaseUrl(NEON, { rehearsal: true }), /this computer/);
});

const realVars = (over = {}) => ({
  DATABASE_URL: normalizeDatabaseUrl(NEON),
  ...newSecrets(),
  H2G_DIRECT_GARMIN_LOGIN: "1",
  H2G_UPDATE_CHECK: "off",
  H2G_GATE_F: "approved-by-owner",
  H2G_GATE_F_HEVY_ID: "a1b2c3d4-real",
  H2G_GATE_F_GARMIN_ACTIVITY_ID: "21234567890",
  H2G_GATE_F_EXPIRES: isoSeconds(Date.now() + 3 * 86400e3),
  ...over,
});

test("env file: exactly the gate F variables, every value checked", () => {
  const ok = parseEnvFile(envFileText(realVars()));
  assert.equal(ok.rehearsal, false);
  assert.equal(ok.expired, false);
  const cases = [
    [`${envFileText(realVars())}H2G_STRICT_AUTOMATIC=1\n`, /only the gate F variables/],
    [`${envFileText(realVars())}H2G_PRODUCTION_CUTOVER=1\n`, /only the gate F variables/],
    [`${envFileText(realVars())}GARMIN_PASSWORD=x\n`, /only the gate F variables/],
    [`${envFileText(realVars())}VERCEL=1\n`, /only the gate F variables/],
    // A real file turned into a "rehearsal": the real-login switches are refused in staging.
    [`${envFileText(realVars())}H2G_STAGING=synthetic\n`, /only the gate F variables/],
    [envFileText(realVars({ H2G_GATE_F_HEVY_ID: "syn-legs" })), /synthetic staging/],
    [envFileText(realVars({ H2G_GATE_F_GARMIN_ACTIVITY_ID: "0123" })), /Garmin activity/],
    [envFileText(realVars({ H2G_GATE_F_EXPIRES: isoSeconds(Date.now() + 15 * 86400e3) })), /14 days/],
    [envFileText(realVars({ H2G_GATE_F_EXPIRES: "2026-11-31T10:00:00+01:00" })), /ISO time/],
    [envFileText(realVars({ DATABASE_URL: NEON })), /checked form/],
    [envFileText(realVars({ H2G_UPDATE_CHECK: "on" })), /UPDATE_CHECK/],
    [envFileText(realVars({ H2G_GATE_F: "yes" })), /approved-by-owner/],
    [envFileText(realVars({ HEVY2GARMIN_SECRET: "short" })), /64 hex/],
    [envFileText(realVars({ H2G_CREDENTIALS_KEY: "c2hvcnQ=" })), /32 bytes/],
    [envFileText(realVars({ H2G_PASSWORD: "short" })), /too short/],
    [`${envFileText(realVars())}DATABASE_URL=x\n`, /twice/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseEnvFile(text), re, String(re));
  // An expired authorization still starts (preview, evidence and restore stay possible).
  assert.equal(parseEnvFile(envFileText(realVars({ H2G_GATE_F_EXPIRES: isoSeconds(Date.now() - 1000) }))).expired, true);
});

test("env file: the rehearsal is synthetic and local only, without the real-login switches", () => {
  const vars = realVars({
    DATABASE_URL: normalizeDatabaseUrl("postgres://u:p@127.0.0.1:5432/h2g", { rehearsal: true }),
    H2G_GATE_F_HEVY_ID: "syn-legs",
    H2G_GATE_F_GARMIN_ACTIVITY_ID: "9100001",
    H2G_STAGING: "synthetic",
  });
  const text = envFileText(vars, { rehearsal: true });
  assert.equal(parseEnvFile(text).rehearsal, true);
  assert.doesNotMatch(text, /H2G_DIRECT_GARMIN_LOGIN|H2G_CREDENTIALS_KEY/);
  assert.throws(() => parseEnvFile(`${text}H2G_CREDENTIALS_KEY=${vars.H2G_CREDENTIALS_KEY}\n`), /only the gate F variables/);
  assert.throws(() => parseEnvFile(`${text}H2G_DIRECT_GARMIN_LOGIN=1\n`), /only the gate F variables/);
  assert.throws(() => parseEnvFile(envFileText({ ...vars, DATABASE_URL: normalizeDatabaseUrl(NEON) }, { rehearsal: true })), /this computer/);
  assert.throws(() => parseEnvFile(envFileText({ ...vars, H2G_GATE_F_HEVY_ID: "a1b2c3" }, { rehearsal: true })), /synthetic workout/);
});

test("secrets: fresh, random, the sizes the dashboard expects", () => {
  const a = newSecrets();
  const b = newSecrets();
  assert.notEqual(a.H2G_PASSWORD, b.H2G_PASSWORD);
  assert.equal(a.H2G_PASSWORD.length, 20);
  assert.match(a.HEVY2GARMIN_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(a.H2G_CREDENTIALS_KEY, "base64").length, 32);
});

test("inherited variables that could steer the server or Node are refused", () => {
  const env = {
    PATH: "x", USERPROFILE: "x", GATE_F_HOME: "x", GATE_F_REHEARSAL_DATABASE_URL: "x",
    VERCEL: "1", NODE_OPTIONS: "--require x", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_EXTRA_CA_CERTS: "x",
    H2G_STRICT_AUTOMATIC: "1", GARMIN_PASSWORD: "x", DATABASE_URL: "x", PGPASSWORD: "x", NEON_DATABASE_URL: "x",
    NEXT_PUBLIC_X: "x", PORT: "1", HOSTNAME: "box", AWS_LAMBDA_FUNCTION_NAME: "x", EMPTY_IS_FINE: "",
  };
  assert.deepEqual(unsafeInherited({ ...env, NODE_USE_SYSTEM_CA: "1", OPENSSL_CONF: "x", NODE_COMPILE_CACHE: "x", UV_THREADPOOL_SIZE: "64", UV_CACHE_DIR: "x" }, "win32"), [
    "AWS_LAMBDA_FUNCTION_NAME", "DATABASE_URL", "GARMIN_PASSWORD", "H2G_STRICT_AUTOMATIC", "HOSTNAME", "NEON_DATABASE_URL",
    "NEXT_PUBLIC_X", "NODE_COMPILE_CACHE", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA",
    "OPENSSL_CONF", "PGPASSWORD", "PORT", "VERCEL",
  ]);
  assert.ok(!unsafeInherited(env, "linux").includes("HOSTNAME"), "bash exports HOSTNAME on Linux");
  assert.deepEqual(unsafeInherited({ PATH: "x", VERCEL: "" }, "win32"), []);
});

test("the server's environment starts empty: nothing inherited but what the platform needs", () => {
  const parent = { SystemRoot: "C:\\Windows", PATH: "C:\\evil", USERPROFILE: "C:\\Users\\Jörg Müller", SECRET_TOKEN: "x", DATABASE_URL: "x", NODE_OPTIONS: "x", comspec: "C:\\Windows\\system32\\cmd.exe" };
  const env = cleanEnv(parent, { root: "C:\\Users\\Jörg Müller\\AppData\\Local\\g f", nodeDir: "C:\\n", platform: "win32", extra: { PORT: "8096" } });
  assert.deepEqual(Object.keys(env).sort(), ["ComSpec", "PATH", "PORT", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]);
  assert.equal(env.PATH, "C:\\n;C:\\Windows/System32".replace("/", process.platform === "win32" ? "\\" : "/"));
  assert.equal(env.USERPROFILE, "C:\\Users\\Jörg Müller");
  assert.equal(env.ComSpec, join("C:\\Windows", "System32", "cmd.exe"), "ComSpec is pinned, not taken from the window");
});

test("manifest: format, duplicates and escapes refused; a tree verifies exactly", () => {
  assert.throws(() => parseManifest(""), /empty/);
  assert.throws(() => parseManifest(`${"a".repeat(64)}  ../x\n`), /malformed/);
  assert.throws(() => parseManifest(`${"a".repeat(64)}  /x\n`), /malformed/);
  assert.throws(() => parseManifest(`${"a".repeat(64)}  x\n${"b".repeat(64)}  x\n`), /twice/);
  const dir = mkdtempSync(join(tmpdir(), "h2g-manifest-"));
  try {
    mkdirSync(join(dir, "web", "lib"), { recursive: true });
    mkdirSync(join(dir, "typescript"), { recursive: true });
    mkdirSync(join(dir, "tools", "gate-f-windows"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    const files = { "web/lib/a.ts": "a\n", "typescript/b.ts": "b\n", "tools/gate-f-windows/gate-f.mjs": "c\n" };
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
    writeFileSync(join(dir, "tools/gate-f-windows/gate-f.cmd"), "unlisted\r\n");
    writeFileSync(join(dir, "docs/readme.md"), "outside the scopes\n");
    const manifest = `${Object.entries(files).sort().map(([p, c]) => `${sha256(Buffer.from(c))}  ${p}`).join("\n")}\n`;
    assert.equal(verifySource(dir, manifest).ok, true);
    writeFileSync(join(dir, "web/lib/a.ts"), "A\n");
    assert.deepEqual(verifySource(dir, manifest).changed, ["web/lib/a.ts"]);
    writeFileSync(join(dir, "web/lib/a.ts"), "a\n");
    writeFileSync(join(dir, "web/lib/new.ts"), "added\n");
    assert.deepEqual(verifySource(dir, manifest).extra, ["web/lib/new.ts"]);
    rmSync(join(dir, "web/lib/new.ts"));
    rmSync(join(dir, "typescript/b.ts"));
    assert.deepEqual(verifySource(dir, manifest).missing, ["typescript/b.ts"]);
    writeFileSync(join(dir, "typescript/b.ts"), "b\n");
    symlinkSync(join(dir, "docs"), join(dir, "web", "link"), "dir");
    assert.throws(() => verifySource(dir, manifest), /symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listeners: only 127.0.0.1 passes, whatever the Windows language", () => {
  const de = [
    "Aktive Verbindungen",
    "  Proto  Lokale Adresse         Remoteadresse          Status           PID",
    "  TCP    127.0.0.1:8096         0.0.0.0:0              ABHÖREN          4242",
    "  TCP    127.0.0.1:8096         127.0.0.1:51000        HERGESTELLT      4242",
    "  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1000",
  ].join("\r\n");
  assert.deepEqual(parseNetstatListeners(de, 8096), [{ address: "127.0.0.1", pid: 4242 }]);
  assert.equal(loopbackOnly(parseNetstatListeners(de, 8096)), true);
  const open = `${de}\r\n  TCP    0.0.0.0:8096           0.0.0.0:0              LISTENING       4242\r\n  TCP    [::]:8096              [::]:0                 LISTENING       4242`;
  assert.deepEqual(parseNetstatListeners(open, 8096).map((l) => l.address), ["127.0.0.1", "0.0.0.0", "::"]);
  assert.equal(loopbackOnly(parseNetstatListeners(open, 8096)), false);
  assert.equal(loopbackOnly([]), false, "nothing listening is not a pass");
  const proc = "  sl  local_address rem_address   st\n   0: 0100007F:1FA0 00000000:0000 0A\n   1: 00000000:1FA0 00000000:0000 0A\n   2: 0100007F:1FA0 0100007F:C350 01\n";
  assert.deepEqual(parseProcNetListeners(proc, 8096).map((l) => l.address), ["127.0.0.1", "0.0.0.0"]);
});

test("ACL: only a protected DACL with the current user alone passes", () => {
  const me = "S-1-5-21-111-222-333-1001";
  const saved = (sddl) => `\uFEFFgate-f.env\r\n${sddl}\r\n`;
  assert.equal(sddlOwnerOnly(saved(`D:PAI(A;;FA;;;${me})`), me).ok, true);
  assert.equal(sddlOwnerOnly(saved(`D:P(A;;FA;;;${me})`), me).ok, true);
  assert.match(sddlOwnerOnly(saved(`D:AI(A;ID;FA;;;${me})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`), me).reason, /inherits/);
  assert.match(sddlOwnerOnly(saved(`D:P(A;;FA;;;${me})(A;;FR;;;WD)`), me).reason, /WD/);
  assert.match(sddlOwnerOnly(saved(`D:P(A;;FA;;;S-1-5-21-9-9-9-500)`), me).reason, /no access/);
  assert.match(sddlOwnerOnly("gate-f.env\r\n", me).reason, /no DACL/);
});

test("the standalone copy replaces links by their content, inside the build only", async () => {
  const { copyResolved } = await import("./gate-f.mjs");
  const { existsSync, lstatSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "h2g-copy-"));
  try {
    mkdirSync(join(dir, "a", "node_modules", "pg"), { recursive: true });
    mkdirSync(join(dir, "a", ".next", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "a", "node_modules", "pg", "index.js"), "pg\n");
    // As Next writes them: relative, with the platform's separator (Windows does not resolve "/").
    symlinkSync(join("..", "..", "node_modules", "pg"), join(dir, "a", ".next", "node_modules", "pg-1"), "dir");
    copyResolved(join(dir, "a"), join(dir, "b"));
    const copied = join(dir, "b", ".next", "node_modules", "pg-1");
    assert.equal(lstatSync(copied).isSymbolicLink(), false);
    assert.equal(readFileSync(join(copied, "index.js"), "utf8"), "pg\n");
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(dir, "a", "escape"), "dir");
    assert.throws(() => copyResolved(join(dir, "a"), join(dir, "c")), /outside the build/);
    rmSync(join(dir, "a", "escape"));
    symlinkSync("..", join(dir, "a", "node_modules", "loop"), "dir");
    assert.throws(() => copyResolved(join(dir, "a"), join(dir, "d")), /cycle/);
    assert.ok(existsSync(join(dir, "b")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module guard: nothing resolves from a node_modules above the gate F folder", async () => {
  const { spawnSync } = await import("node:child_process");
  const { guardEnv } = await import("./gate-f.mjs");
  const { fileURLToPath } = await import("node:url");
  const top = mkdtempSync(join(tmpdir(), "h2g guard ü-"));
  try {
    const marker = join(top, "LOADED");
    // A planted package in a parent folder (as C:\node_modules could be), and the gate F folder below it.
    mkdirSync(join(top, "node_modules", "planted"), { recursive: true });
    writeFileSync(join(top, "node_modules", "planted", "package.json"), '{"name":"planted","main":"index.js","exports":{"import":"./index.mjs","require":"./index.js"}}');
    writeFileSync(join(top, "node_modules", "planted", "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "cjs"); module.exports = 1;`);
    writeFileSync(join(top, "node_modules", "planted", "index.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "esm"); export default 1;`);
    const root = join(top, "gate f");
    mkdirSync(join(root, "node_modules", "inside"), { recursive: true });
    writeFileSync(join(root, "node_modules", "inside", "index.js"), "module.exports = 'ok';");
    writeFileSync(join(root, "cjs.js"), "try { require('planted'); console.log('LOADED'); } catch (e) { console.log(e.code); } console.log(require('inside'));");
    writeFileSync(join(root, "esm.mjs"), "try { await import('planted'); console.log('LOADED'); } catch (e) { console.log(e.code ?? e.message); }");
    const guard = join(fileURLToPath(new URL(".", import.meta.url)), "module-guard.cjs");
    const env = { PATH: process.env.PATH, ...guardEnv(guard, root) };
    const cjs = spawnSync(process.execPath, ["cjs.js"], { cwd: root, env, encoding: "utf8" });
    assert.match(cjs.stdout, /MODULE_NOT_FOUND\s+ok/, cjs.stderr);
    const esm = spawnSync(process.execPath, ["esm.mjs"], { cwd: root, env, encoding: "utf8" });
    assert.doesNotMatch(esm.stdout, /LOADED/, esm.stderr);
    assert.equal(existsSyncLocal(marker), false, "the planted module never ran");
    // Control: without the guard the same script does load it.
    const open = spawnSync(process.execPath, ["cjs.js"], { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.match(open.stdout, /LOADED/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("module guard: NODE_OPTIONS quoting survives spaces and backslashes", async () => {
  const { guardEnv } = await import("./gate-f.mjs");
  const e = guardEnv(["C:", "h2g Prüfung", "gate f", "app", "gate-f-module-guard.cjs"].join("\\"), "C:\\h2g Prüfung\\gate f\\app");
  if (process.platform === "win32") assert.equal(e.NODE_OPTIONS, '--require "C:/h2g Prüfung/gate f/app/gate-f-module-guard.cjs"');
  assert.match(e.NODE_OPTIONS, /^--require "[^"]+"$/);
  assert.equal(e.H2G_MODULE_ROOT, "C:\\h2g Prüfung\\gate f\\app");
});

function existsSyncLocal(p) {
  try {
    return statSyncLocal(p) !== null;
  } catch {
    return false;
  }
}
import { statSync as statSyncLocal } from "node:fs";

test("manifest after the build: listed files must match, build products may exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "h2g-listed-"));
  try {
    mkdirSync(join(dir, "web", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "web", "a.ts"), "a\n");
    symlinkSync(join(dir, "web", "a.ts"), join(dir, "web", "node_modules", ".bin", "tool"), "file");
    const manifest = `${sha256(Buffer.from("a\n"))}  web/a.ts\n`;
    assert.equal(verifySource(dir, manifest, { listedOnly: true }).ok, true);
    writeFileSync(join(dir, "web", "a.ts"), "changed\n");
    assert.deepEqual(verifySource(dir, manifest, { listedOnly: true }).changed, ["web/a.ts"]);
    rmSync(join(dir, "web", "a.ts"));
    assert.deepEqual(verifySource(dir, manifest, { listedOnly: true }).missing, ["web/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACL: the saved answer must be about the file asked for (no stale save)", () => {
  const me = "S-1-5-21-111-222-333-1001";
  // Real icacls /save output on Windows (CI): the name line, then the SDDL.
  const env = `gate-f.env\r\nD:PAI(A;;FR;;;WD)(A;;FA;;;${me})\r\n`;
  assert.deepEqual(savedAclOwnerOnly(env, "gate-f.env", me), { ok: false, reason: "also readable by WD" });
  // The folder's private ACL must never stand in for the env file's.
  const folder = `gate f\r\nD:PAI(A;OICI;FA;;;${me})\r\n`;
  assert.equal(savedAclOwnerOnly(folder, "gate f", me).ok, true);
  assert.match(savedAclOwnerOnly(folder, "gate-f.env", me).reason, /could not be read reliably/);
  assert.equal(savedAclOwnerOnly(`GATE-F.ENV\r\nD:P(A;;FA;;;${me})\r\n`, "gate-f.env", me).ok, true, "names compare case-insensitively");
});
