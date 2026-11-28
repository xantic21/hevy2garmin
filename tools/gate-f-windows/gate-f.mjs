#!/usr/bin/env node
/**
 * Gate F on the owner's own Windows computer, without Docker, WSL or
 * administrator rights (docs/OWNER_RUNBOOK.md, block B). Synthetic CI rehearsal:
 * .github/workflows/ci.yml, job "Gate F on Windows".
 *
 * Started only by gate-f.cmd, which verified the pinned Node.js ZIP, node.exe
 * and this file's SHA-256 first. It runs in the gate F folder (the current
 * directory, default %LOCALAPPDATA%\hevy2garmin-gate-f):
 *
 *   node\        the pinned portable Node.js
 *   src\         the verified source (typescript\, web\, tools\gate-f-windows\)
 *   app\         the built standalone server, read-only, with BUILD_MANIFEST.json
 *   private\     gate-f.env and the server's process record, this user only
 *   tmp\, npm-cache\
 *
 * Commands:
 *   build    --commit <sha> --from <dir>  verify every source file against
 *            SOURCE_MANIFEST.sha256, build engine and dashboard as web/Dockerfile
 *            does, assemble app\ and its build manifest
 *   selftest start the built server with no database and no credentials,
 *            check that it answers, its identity and loopback-only, stop it
 *   prepare  [--rehearsal] check the new Neon database (verified TLS, empty)
 *            and the two ids, write private\gate-f.env (never overwritten)
 *   start    verify app\ and the env file, run the server on 127.0.0.1:8096
 *            with only those variables, check identity, loopback, gate F state
 *   stop     stop the server started by `start`
 *   status   build manifest, env file state, whether the server runs
 *
 * Nothing here weakens a safeguard of the dashboard: it only starts the same
 * build with the same variables as the qualified container, minus Docker.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NODE_VERSION = "v22.23.5";
export const PORT = 8096;
export const SCOPES = ["typescript/", "web/", "tools/gate-f-windows/"];
// Not in the manifest: gate-f.cmd pins the manifest's hash, and the manifest cannot list itself.
export const UNLISTED = ["tools/gate-f-windows/gate-f.cmd", "tools/gate-f-windows/SOURCE_MANIFEST.sha256"];
export const MANIFEST_PATH = "tools/gate-f-windows/SOURCE_MANIFEST.sha256";
const IS_WIN = process.platform === "win32";
// System tools by absolute path: a folder earlier in PATH cannot stand in for them.
const SYS32 = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
const sys = (exe) => (IS_WIN ? join(SYS32, `${exe}.exe`) : exe);
const BUILD_FORMAT = "h2g-gate-f-windows-build-v1";

// ---------------------------------------------------------------- pure helpers

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha256File = (p) => sha256(readFileSync(p));

/** Every file below `dir`, as forward-slash paths relative to `base`. */
export function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`refusing: symbolic link in the tree: ${relative(base, full)}`);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/** "sha256  path" lines; paths relative, forward slashes, never escaping the tree. */
export function parseManifest(text) {
  const map = new Map();
  for (const [i, line] of text.split("\n").entries()) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._@+\-/ \[\]()]+)$/.exec(line);
    if (!m || m[2].startsWith("/") || m[2].split("/").some((s) => s === ".." || s === "." || s === "")) {
      throw new Error(`manifest line ${i + 1} is malformed`);
    }
    if (map.has(m[2])) throw new Error(`manifest lists ${m[2]} twice`);
    map.set(m[2], m[1]);
  }
  if (map.size === 0) throw new Error("manifest is empty");
  return map;
}

/**
 * Compare a source tree with the manifest: every listed file identical and, unless
 * `listedOnly` (after the build, when node_modules, dist and .next exist), nothing else in the scopes.
 */
export function verifySource(dir, manifestText, { listedOnly = false } = {}) {
  const expected = parseManifest(manifestText);
  const actual = listedOnly
    ? [...expected.keys()].filter((p) => existsSync(join(dir, ...p.split("/"))))
    : SCOPES.flatMap((s) => listFiles(join(dir, s), dir)).filter((p) => !UNLISTED.includes(p));
  const missing = [...expected.keys()].filter((p) => !existsSync(join(dir, ...p.split("/"))));
  const extra = actual.filter((p) => !expected.has(p));
  const changed = actual.filter((p) => expected.has(p) && sha256File(join(dir, ...p.split("/"))) !== expected.get(p));
  return { ok: !missing.length && !extra.length && !changed.length, files: expected.size, missing, extra, changed };
}

const HOSTED = /^(VERCEL|NOW_|AWS_LAMBDA|LAMBDA_TASK_ROOT$|NETLIFY|RENDER|RAILWAY_|FLY_|K_SERVICE$|DYNO$)/i;
const UNSAFE = [
  /^H2G_/i, /^HEVY/i, /^GARMIN/i, /^DATABASE_URL/i, /^POSTGRES/i, /^NEON_/i,
  /^PG(HOST|HOSTADDR|PORT|USER|USERNAME|PASSWORD|DATABASE|SSLMODE|SSLROOTCERT|SERVICE|PASSFILE|OPTIONS|APPNAME)$/i,
  // Every NODE_* (options, CA store, compile cache, ICU, …) and OpenSSL variable.
  /^NODE_OPTIONS$/i, /^NODE_TLS_REJECT_UNAUTHORIZED$/i, /^NODE_/i, /^OPENSSL_/i,
  /^NEXT_/i, /^CRON_SECRET$/i, /^COLLECTOR_/i, /^SSL_CERT_(FILE|DIR)$/i, /^PORT$/i,
];

/** Inherited variables that could steer the server, its TLS or Node itself. */
export function unsafeInherited(env, platform = process.platform) {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "")
    .filter((k) => HOSTED.test(k) || UNSAFE.some((r) => r.test(k)) || (platform === "win32" && /^HOSTNAME$/i.test(k)))
    .sort();
}

const HOST_NEON = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.neon\.tech$/i;
const LOCAL = new Set(["127.0.0.1", "localhost"]);

/**
 * The connection string the server will use. Real: a Neon host, user,
 * password and database, nothing else kept, and `sslmode=verify-full` (the
 * driver treats Neon's default `require` as "encrypt, but accept any
 * certificate"). Rehearsal: a local database without TLS.
 */
export function normalizeDatabaseUrl(raw, { rehearsal = false } = {}) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("refusing: not a connection string");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("refusing: not a Postgres connection string");
  if (!u.username || !u.password) throw new Error("refusing: the connection string has no user or password");
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(db)) throw new Error("refusing: the connection string names no database");
  if (u.port && !/^\d{1,5}$/.test(u.port)) throw new Error("refusing: invalid port");
  if (rehearsal) {
    if (!LOCAL.has(u.hostname)) throw new Error("refusing: the rehearsal database must be on this computer (127.0.0.1)");
    return `postgres://${u.username}:${u.password}@${u.hostname}:${u.port || 5432}/${db}?sslmode=disable`;
  }
  if (!HOST_NEON.test(u.hostname)) throw new Error("refusing: gate F needs its new Neon database (host …neon.tech)");
  return `postgresql://${u.username}:${u.password}@${u.hostname}${u.port ? `:${u.port}` : ""}/${db}?sslmode=verify-full`;
}

export const ID_HEVY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const ID_GARMIN = /^[1-9][0-9]{0,15}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REAL_KEYS = [
  "DATABASE_URL", "H2G_PASSWORD", "HEVY2GARMIN_SECRET", "H2G_CREDENTIALS_KEY", "H2G_DIRECT_GARMIN_LOGIN",
  "H2G_UPDATE_CHECK", "H2G_GATE_F", "H2G_GATE_F_HEVY_ID", "H2G_GATE_F_GARMIN_ACTIVITY_ID", "H2G_GATE_F_EXPIRES",
];
// The staging quarantine refuses the real-login switches (deploy-quarantine.ts STAGING_FORBIDDEN_ENV).
const REHEARSAL_KEYS = [...REAL_KEYS.filter((k) => k !== "H2G_DIRECT_GARMIN_LOGIN" && k !== "H2G_CREDENTIALS_KEY"), "H2G_STAGING"];

export function envFileText(v, { rehearsal = false } = {}) {
  const lines = [
    rehearsal
      ? "# Gate F REHEARSAL (synthetic, local database). Never used for a real activity."
      : "# Gate F: ONE owner-authorized activity. Private: keep it in your password manager, never commit or share.",
    ...(rehearsal ? REHEARSAL_KEYS : REAL_KEYS).map((k) => `${k}=${v[k]}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Parse and check the env file: exactly the expected keys, nothing else, every value well-formed. */
export function parseEnvFile(text, now = Date.now()) {
  const vars = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`env file line ${i + 1} is malformed`);
    const k = line.slice(0, eq);
    if (k in vars) throw new Error(`env file sets ${k} twice`);
    vars[k] = line.slice(eq + 1);
  }
  const rehearsal = vars.H2G_STAGING !== undefined;
  const keys = rehearsal ? REHEARSAL_KEYS : REAL_KEYS;
  const unexpected = Object.keys(vars).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !vars[k]);
  if (unexpected.length) throw new Error(`refusing: the env file sets ${unexpected.join(", ")}; only the gate F variables are allowed`);
  if (missing.length) throw new Error(`refusing: the env file lacks ${missing.join(", ")}`);
  if (rehearsal && vars.H2G_STAGING !== "synthetic") throw new Error("refusing: H2G_STAGING must be synthetic");
  if (vars.H2G_GATE_F !== "approved-by-owner") throw new Error("refusing: H2G_GATE_F must be approved-by-owner");
  if (vars.H2G_UPDATE_CHECK !== "off") throw new Error("refusing: H2G_UPDATE_CHECK=off is required");
  if (!rehearsal && vars.H2G_DIRECT_GARMIN_LOGIN !== "1") throw new Error("refusing: H2G_DIRECT_GARMIN_LOGIN=1 is required (direct sign-in, no third-party worker)");
  if (normalizeDatabaseUrl(vars.DATABASE_URL, { rehearsal }) !== vars.DATABASE_URL) throw new Error("refusing: DATABASE_URL is not in the checked form (run prepare)");
  const hevy = vars.H2G_GATE_F_HEVY_ID;
  if (!ID_HEVY.test(hevy)) throw new Error("refusing: not a Hevy workout id");
  if (rehearsal !== hevy.startsWith("syn-")) throw new Error(rehearsal ? "refusing: a rehearsal uses the synthetic workout" : "refusing: syn-… ids belong to the synthetic staging");
  if (!ID_GARMIN.test(vars.H2G_GATE_F_GARMIN_ACTIVITY_ID)) throw new Error("refusing: not a Garmin activity id");
  if (!ISO_Z.test(vars.H2G_GATE_F_EXPIRES) || Number.isNaN(Date.parse(vars.H2G_GATE_F_EXPIRES))) throw new Error("refusing: H2G_GATE_F_EXPIRES is not an ISO time in UTC");
  if (Date.parse(vars.H2G_GATE_F_EXPIRES) - now > 14 * 86400e3) throw new Error("refusing: the authorization runs more than 14 days");
  if (vars.H2G_PASSWORD.length < 16) throw new Error("refusing: the dashboard password is too short");
  if (!/^[0-9a-f]{64}$/.test(vars.HEVY2GARMIN_SECRET)) throw new Error("refusing: HEVY2GARMIN_SECRET must be 64 hex characters");
  if (!rehearsal && Buffer.from(vars.H2G_CREDENTIALS_KEY, "base64").length !== 32) throw new Error("refusing: H2G_CREDENTIALS_KEY must be 32 bytes in base64");
  return { vars, rehearsal, expired: Date.parse(vars.H2G_GATE_F_EXPIRES) <= now };
}

export function newSecrets() {
  return {
    H2G_PASSWORD: randomBytes(15).toString("base64url"),
    HEVY2GARMIN_SECRET: randomBytes(32).toString("hex"),
    H2G_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
  };
}

export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const KEEP_WIN = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
const KEEP_POSIX = ["HOME", "USER", "LANG"];

/** The child's environment starts empty: only what the platform needs, then exactly the given variables. */
export function cleanEnv(parent, { root, nodeDir, platform = process.platform, extra = {} }) {
  const env = {};
  const keep = platform === "win32" ? KEEP_WIN : KEEP_POSIX;
  const lower = new Map(Object.keys(parent).map((k) => [k.toLowerCase(), k]));
  for (const k of keep) {
    const src = lower.get(k.toLowerCase());
    if (src !== undefined && parent[src] !== undefined) env[k] = parent[src];
  }
  const tmp = join(root, "tmp");
  if (platform === "win32") {
    const sys = env.SystemRoot ?? "C:\\Windows";
    env.ComSpec = join(sys, "System32", "cmd.exe");
    env.PATH = [nodeDir, join(sys, "System32")].join(";");
    env.TEMP = tmp;
    env.TMP = tmp;
  } else {
    env.PATH = [nodeDir, "/usr/bin", "/bin"].join(":");
    env.TMPDIR = tmp;
  }
  return { ...env, ...extra };
}

/** `netstat -ano` (Windows): the TCP sockets listening on `port`, with address and PID. */
export function parseNetstatListeners(text, port) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || !/^TCP$/i.test(c[0])) continue;
    const [, local, foreign] = c;
    if (!/^(0\.0\.0\.0|\[::\]):0$/.test(foreign)) continue;
    const at = local.lastIndexOf(":");
    if (Number(local.slice(at + 1)) !== port) continue;
    out.push({ address: local.slice(0, at).replace(/^\[|\]$/g, ""), pid: Number(c[c.length - 1]) });
  }
  return out;
}

/** /proc/net/tcp{,6} (Linux, tests): listening sockets on `port`. */
export function parseProcNetListeners(text, port, v6 = false) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 4 || c[3] !== "0A") continue;
    const [hexAddr, hexPort] = c[1].split(":");
    if (parseInt(hexPort, 16) !== port) continue;
    let address;
    if (!v6) address = hexAddr.match(/../g).reverse().map((h) => parseInt(h, 16)).join(".");
    else address = hexAddr === "00000000000000000000000001000000" ? "::1" : hexAddr === "0".repeat(32) ? "::" : hexAddr;
    out.push({ address, pid: null });
  }
  return out;
}

export const loopbackOnly = (listeners) => listeners.length > 0 && listeners.every((l) => l.address === "127.0.0.1");

/** `icacls <path> /save <file>` output (UTF-16): the path line, then the SDDL. */
export function sddlOwnerOnly(saved, sid) {
  const sddl = saved.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("D:"));
  if (!sddl) return { ok: false, reason: "no DACL" };
  const flags = /^D:([A-Z]*)\(/.exec(sddl)?.[1] ?? "";
  if (!flags.includes("P")) return { ok: false, reason: "inherits permissions from its folder" };
  const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
  const others = aces.filter((a) => a[0] === "A" && a[5] !== sid);
  if (!aces.some((a) => a[0] === "A" && a[5] === sid)) return { ok: false, reason: "the current user has no access" };
  if (others.length) return { ok: false, reason: `also readable by ${others.map((a) => a[5]).join(", ")}` };
  return { ok: true, reason: null };
}

/**
 * Copy a tree with every link replaced by what it points to. A link must stay
 * inside `within`; cycles refused. Plain JS over copyFileSync on purpose:
 * fs.cpSync's native implementation aborts the process on Windows for paths
 * with non-ASCII characters (a user name with an umlaut), and its `dereference`
 * keeps nested links.
 */
export function copyResolved(from, to, within = realpathSync(from), stack = new Set()) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    const real = realpathSync(from);
    if (real !== within && !real.startsWith(within + sep)) throw new Error(`refusing: ${from} links outside the build`);
    return copyResolved(real, to, within, stack);
  }
  if (st.isDirectory()) {
    const real = realpathSync(from);
    if (stack.has(real)) throw new Error(`refusing: link cycle at ${from}`);
    stack.add(real);
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyResolved(join(from, name), join(to, name), within, stack);
    stack.delete(real);
    return;
  }
  if (st.isFile()) return copyFileSync(from, to);
  throw new Error(`refusing: ${from} is neither a file nor a folder`);
}

// ---------------------------------------------------------------- platform

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} failed (exit ${r.status})`);
  return r;
}
const capture = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  return r;
};

function userSid() {
  const out = capture(sys("whoami"), ["/user", "/fo", "csv", "/nh"]).stdout ?? "";
  const sid = /S-1-5-[0-9-]+/.exec(out)?.[0];
  if (!sid) throw new Error("cannot determine the current user's SID");
  return sid;
}

function elevated() {
  if (!IS_WIN) return false;
  // High or System mandatory level: an elevated (administrator) or SYSTEM token.
  return /S-1-16-(12288|16384)\b/.test(capture(sys("whoami"), ["/groups"]).stdout ?? "");
}

/** Only the current user may use `p`; `mode` "full", "read" (read and execute) or "modify". */
function restrict(p, mode, { tree = false } = {}) {
  if (!IS_WIN) {
    const fileMode = mode === "read" ? 0o444 : 0o600;
    const dirMode = mode === "read" ? 0o555 : 0o700;
    const apply = (q) => chmodSync(q, statSync(q).isDirectory() ? dirMode : fileMode);
    if (tree && statSync(p).isDirectory()) {
      for (const f of listFiles(p)) apply(join(p, ...f.split("/")));
      for (const d of listDirs(p)) apply(d);
    }
    apply(p);
    return;
  }
  const sid = userSid();
  const right = mode === "read" ? "RX" : mode === "modify" ? "M" : "F";
  const dir = statSync(p).isDirectory();
  // On a folder the inheritable entry propagates to everything below it that inherits.
  if (mode === "modify" && dir) run(sys("icacls"), [p, "/grant", `*${sid}:(OI)(CI)(M)`, "/C", "/Q"], { stdio: "ignore" });
  else run(sys("icacls"), [p, "/inheritance:r", "/grant:r", `*${sid}:${dir ? "(OI)(CI)" : ""}(${right})`, "/C", "/Q"], { stdio: "ignore" });
}

function listDirs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const full = join(dir, e.name);
      out.push(full, ...listDirs(full));
    }
  }
  return out;
}

/** Give the current user full control again (before deleting a read-only tree). */
function unlock(p) {
  if (!existsSync(p)) return;
  if (!IS_WIN) {
    // Folders writable again, links left alone (rmSync removes a link, not its target).
    for (const d of [p, ...(statSync(p).isDirectory() ? listDirs(p) : [])]) chmodSync(d, 0o700);
    return;
  }
  run(sys("icacls"), [p, "/grant", `*${userSid()}:(OI)(CI)(F)`, "/C", "/Q"], { stdio: "ignore" });
}

/** Only this user can read `p`? */
function ownerOnly(p, root) {
  if (!IS_WIN) {
    const st = statSync(p);
    const ok = (st.mode & 0o077) === 0 && (typeof process.getuid !== "function" || st.uid === process.getuid());
    return { ok, reason: ok ? null : `mode ${(st.mode & 0o777).toString(8)}` };
  }
  const out = join(root, "tmp", `acl-${process.pid}.txt`);
  try {
    run(sys("icacls"), [p, "/save", out, "/C", "/Q"], { stdio: "ignore" });
    return sddlOwnerOnly(readFileSync(out, "utf16le"), userSid());
  } finally {
    rmSync(out, { force: true });
  }
}

function listeners(port) {
  if (IS_WIN) return parseNetstatListeners(capture(sys("netstat"), ["-ano", "-p", "TCP"]).stdout + capture(sys("netstat"), ["-ano", "-p", "TCPv6"]).stdout, port);
  const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return [...parseProcNetListeners(read("/proc/net/tcp"), port), ...parseProcNetListeners(read("/proc/net/tcp6"), port, true)];
}

const portBusy = (port) =>
  new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => (s.destroy(), res(true)));
    s.on("error", () => res(false));
    s.setTimeout(1500, () => (s.destroy(), res(false)));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function npmCli() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error("npm not found next to node");
  return hit;
}

// ---------------------------------------------------------------- layout and checks

function layout(root) {
  return {
    root,
    node: join(root, "node"),
    src: join(root, "src"),
    app: join(root, "app"),
    priv: join(root, "private"),
    tmp: join(root, "tmp"),
    cache: join(root, "npm-cache"),
    env: join(root, "private", "gate-f.env"),
    pid: join(root, "private", "server.json"),
    build: join(root, "app", "BUILD_MANIFEST.json"),
  };
}

function say(m = "") {
  process.stdout.write(`${m}\n`);
}
function refuse(m) {
  const e = new Error(m);
  e.refusal = true;
  throw e;
}

function preflight(L) {
  if (process.version !== NODE_VERSION) refuse(`refusing: Node ${process.version}; gate F is qualified on ${NODE_VERSION} only`);
  if (IS_WIN) {
    if (resolve(process.execPath).toLowerCase() !== resolve(L.node, "node.exe").toLowerCase()) refuse("refusing: not started by gate-f.cmd with the portable Node.js");
    if (process.arch !== "x64") refuse(`refusing: ${process.arch}; only Windows x64 is qualified`);
    if (elevated()) refuse("refusing: this window runs as administrator; use a normal (non-administrator) Command Prompt");
    const synced = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map((k) => process.env[k]).filter(Boolean);
    if (/\\onedrive/i.test(L.root) || synced.some((d) => L.root.toLowerCase().startsWith(resolve(d).toLowerCase()))) {
      refuse("refusing: the gate F folder is inside OneDrive; use a local, unsynced folder");
    }
  }
  const bad = unsafeInherited(process.env);
  if (bad.length) refuse(`refusing: these variables are set in this window and could steer the server: ${bad.join(", ")}. Open a new Command Prompt without them`);
  mkdirSync(L.tmp, { recursive: true });
  if (!IS_WIN) restrict(L.root, "full");
  // The whole folder is this user's alone (gate-f.cmd sets it; checked here): no other local
  // account can swap a file between a check and its use.
  const acl = ownerOnly(L.root, L.root);
  if (!acl.ok) refuse(`refusing: the gate F folder is not private to you (${acl.reason})`);
}

function readBuild(L) {
  if (!existsSync(L.build)) refuse("refusing: no build yet; run gate-f.cmd setup first");
  return JSON.parse(readFileSync(L.build, "utf8"));
}

/** Every file of app\ as built, nothing added or changed (the writable cache aside). */
function verifyApp(L, build) {
  if (build.format !== BUILD_FORMAT) refuse("refusing: unknown build manifest format");
  // Next copies prerendered pages here when it may write (it cannot in the read-only app\ of a
  // normal user, and skips it silently). A cache, never trusted: removed before the check.
  rmSync(join(L.app, ".next", "server", "route-cache"), { recursive: true, force: true });
  const want = new Map(build.files);
  const have = listFiles(L.app).filter((p) => p !== "BUILD_MANIFEST.json" && !p.startsWith(".next/cache/"));
  const extra = have.filter((p) => !want.has(p));
  const missing = [...want.keys()].filter((p) => !have.includes(p));
  const changed = have.filter((p) => want.has(p) && sha256File(join(L.app, ...p.split("/"))) !== want.get(p));
  if (extra.length || missing.length || changed.length) {
    refuse(`refusing: app\\ differs from its build (changed ${changed.length}, added ${extra.length}, missing ${missing.length}): ${[...changed, ...extra, ...missing].slice(0, 5).join(", ")}`);
  }
  if (sha256(JSON.stringify(build.files)) !== build.filesSha256) refuse("refusing: the build manifest is inconsistent");
}

const GUARD_IN_APP = "gate-f-module-guard.cjs";

/** Node loads the module guard first; NODE_OPTIONS reaches npm, next build and its workers. */
export function guardEnv(guardPath, ...moduleRoots) {
  // Forward slashes: inside quotes NODE_OPTIONS treats a backslash as an escape.
  return { NODE_OPTIONS: `--require "${guardPath.split(sep).join("/")}"`, H2G_MODULE_ROOT: moduleRoots.join(delimiter) };
}

/** Every file of the portable Node.js, hashed (a DLL next to node.exe would load first). */
function nodeFiles(L) {
  if (!IS_WIN) return [];
  return listFiles(L.node).map((p) => [p, sha256File(join(L.node, ...p.split("/")))]);
}

/**
 * Before the server starts: Node unchanged since the build, the source still the pinned
 * one, and app\ built from it (source manifest and engine digest recorded at build time).
 */
async function verifyRuntime(L, build) {
  if (IS_WIN) {
    const now = nodeFiles(L);
    if (sha256(JSON.stringify(now)) !== build.node.filesSha256) refuse("refusing: the portable Node.js differs from the one the build used");
  }
  const manifestText = readFileSync(join(L.src, MANIFEST_PATH), "utf8");
  if (sha256(manifestText) !== build.sourceManifestSha256) refuse("refusing: app\\ was built from another source manifest");
  const v = verifySource(L.src, manifestText, { listedOnly: true });
  if (!v.ok) refuse(`refusing: src\\ differs from its manifest (${[...v.changed, ...v.extra, ...v.missing].slice(0, 3).join(", ")})`);
  const { sourceDigest } = await import(pathToFileURL(join(L.src, "typescript", "scripts", "engine-stamp.mjs")).href);
  if (sourceDigest(join(L.src, "typescript")) !== build.engineSourceSha256) refuse("refusing: app\\ was built from another engine source");
}

// ---------------------------------------------------------------- build

function build(L, { commit, from }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) refuse("refusing: --commit must be the full 40-character commit id");
  const fromDir = resolve(from ?? "");
  if (!existsSync(join(fromDir, MANIFEST_PATH))) refuse("refusing: --from is not the downloaded source");
  const manifestText = readFileSync(join(fromDir, MANIFEST_PATH), "utf8");
  say(`Verifying the source of ${commit} against its manifest…`);
  const v = verifySource(fromDir, manifestText);
  if (!v.ok) refuse(`refusing: the source differs from its manifest (changed ${v.changed.length}, added ${v.extra.length}, missing ${v.missing.length}): ${[...v.changed, ...v.extra, ...v.missing].slice(0, 5).join(", ")}`);
  say(`  ${v.files} files identical`);

  for (const d of [L.src, L.app]) {
    unlock(d);
    rmSync(d, { recursive: true, force: true });
  }
  for (const s of SCOPES) copyResolved(join(fromDir, s), join(L.src, s));
  copyFileSync(join(fromDir, MANIFEST_PATH), join(L.src, MANIFEST_PATH));
  // What is built is what was checked: the copy itself is verified again.
  const again = verifySource(L.src, manifestText);
  if (!again.ok) refuse("refusing: the copied source differs from its manifest");
  mkdirSync(L.cache, { recursive: true });

  const npm = npmCli();
  // npm reads no user or global .npmrc (they could set a script shell or node options).
  const userRc = join(L.tmp, "user.npmrc");
  const globalRc = join(L.tmp, "global.npmrc");
  writeFileSync(userRc, "");
  writeFileSync(globalRc, "");
  const guard = join(L.src, "tools", "gate-f-windows", "module-guard.cjs");
  const base = cleanEnv(process.env, {
    root: L.root,
    nodeDir: dirname(process.execPath),
    extra: {
      // npm's own folder: inside node\ on Windows; the system Node's on Linux (tests).
      ...guardEnv(guard, L.root, dirname(dirname(npm))),
      npm_config_userconfig: userRc,
      npm_config_globalconfig: globalRc,
      npm_config_cache: L.cache,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      NEXT_TELEMETRY_DISABLED: "1",
      // npm alone may need the owner's proxy (and its CA) to reach the registry; the server
      // never gets them. Every package is still checked against the lockfile's integrity hash.
      ...Object.fromEntries(
        ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "npm_config_cafile"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      ),
    },
  });
  const ts = join(L.src, "typescript");
  const web = join(L.src, "web");
  say("Building the strict engine (typescript/)…");
  run(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], { cwd: ts, env: base });
  run(process.execPath, [npm, "run", "build"], { cwd: ts, env: base });
  say("Installing and building the dashboard (web/)…");
  run(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], { cwd: web, env: base });
  run(process.execPath, [join(web, "scripts", "verify-engine.mjs")], { cwd: web, env: base });
  // Routes are force-dynamic: the build never connects; it only needs a URL to be set (as in web/Dockerfile).
  run(process.execPath, [npm, "run", "build"], { cwd: web, env: { ...base, DATABASE_URL: "postgres://build:build@localhost:5432/build", H2G_BASE_PATH: "" } });

  say("Assembling the standalone server in app\\…");
  const standalone = join(web, ".next", "standalone");
  if (!existsSync(join(standalone, "server.js"))) refuse("refusing: the build produced no standalone server");
  // Next links traced packages (.next/node_modules/<name>-<hash>); on Windows without
  // administrator rights as junctions to absolute paths in the build tree. Real copies
  // keep app\ self-contained, relocatable and fully covered by its manifest.
  copyResolved(standalone, L.app);
  copyResolved(join(web, ".next", "static"), join(L.app, ".next", "static"));
  copyFileSync(guard, join(L.app, GUARD_IN_APP));
  mkdirSync(join(L.app, ".next", "cache"), { recursive: true });

  const files = listFiles(L.app).filter((p) => !p.startsWith(".next/cache/")).map((p) => [p, sha256File(join(L.app, ...p.split("/")))]);
  const stamp = readFileSync(join(web, "node_modules", "hevy2garmin", "dist", "ENGINE_SOURCE_SHA256"), "utf8").trim();
  const buildManifest = {
    format: BUILD_FORMAT,
    commit,
    builtAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: { version: process.version, sha256: sha256File(process.execPath), files: nodeFiles(L), filesSha256: null },
    sourceManifestSha256: sha256(manifestText),
    engineSourceSha256: stamp,
    files,
    filesSha256: sha256(JSON.stringify(files)),
  };
  buildManifest.node.filesSha256 = sha256(JSON.stringify(buildManifest.node.files));
  writeFileSync(L.build, `${JSON.stringify(buildManifest, null, 1)}\n`);
  restrict(L.app, "read", { tree: true });
  restrict(join(L.app, ".next", "cache"), "modify");
  say("");
  say(`Built ${commit}`);
  say(`  Node ${process.version}, engine source ${stamp.slice(0, 16)}…`);
  say(`  source manifest SHA-256 ${buildManifest.sourceManifestSha256}`);
  say(`  build manifest  SHA-256 ${buildManifest.filesSha256} (${files.length} files)`);
  say("Next: gate-f.cmd selftest");
}

// ---------------------------------------------------------------- server

function serverEnv(L, build, vars) {
  return cleanEnv(process.env, {
    root: L.root,
    nodeDir: dirname(process.execPath),
    extra: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      HEVY2GARMIN_COMMIT_SHA: build.commit,
      ...guardEnv(join(L.app, GUARD_IN_APP), L.app),
      ...vars,
    },
  });
}

async function http(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML page
  }
  return { status: res.status, data, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
}

function launch(L, env) {
  mkdirSync(L.tmp, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], { cwd: L.app, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const relay = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        process.stdout.write(`  [server] ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  };
  relay(child.stdout);
  relay(child.stderr);
  return child;
}

async function waitReady(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) refuse(`the server stopped during start (exit ${child.exitCode})`);
    try {
      if ((await http("/login")).status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  refuse("the server did not answer within 90 seconds");
}

async function checkIdentityAndListener(build, child) {
  const v = await http("/api/version");
  if (v.status !== 200 || v.data?.commit !== build.commit || v.data?.source !== "env" || v.data?.env !== "self-hosted") {
    refuse(`refusing: /api/version reports ${JSON.stringify(v.data)}, expected ${build.commit}`);
  }
  const l = listeners(PORT);
  if (!loopbackOnly(l)) refuse(`refusing: port ${PORT} is reachable on ${l.map((x) => x.address).join(", ") || "nothing"}; only 127.0.0.1 is allowed`);
  if (IS_WIN && l.some((x) => x.pid !== child.pid)) refuse(`refusing: another process also listens on port ${PORT}`);
  return l;
}

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  if (IS_WIN) spawnSync(sys("taskkill"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
  for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(250);
};

async function waitPortFree() {
  for (let i = 0; i < 40; i++) {
    if (!(await portBusy(PORT))) return true;
    await sleep(250);
  }
  return false;
}

async function selftest(L) {
  const build = readBuild(L);
  say("Verifying Node.js, the source and app\\ against the build…");
  verifyApp(L, build);
  await verifyRuntime(L, build);
  if (await portBusy(PORT)) refuse(`refusing: port ${PORT} is in use; stop the other server first (gate-f.cmd stop)`);
  const password = randomBytes(15).toString("base64url");
  // No database, no credentials, no gate F: the bare server, to prove this computer runs it.
  const child = launch(L, serverEnv(L, build, { H2G_PASSWORD: password, H2G_UPDATE_CHECK: "off", H2G_DIRECT_GARMIN_LOGIN: "1" }));
  try {
    await waitReady(child);
    const l = await checkIdentityAndListener(build, child);
    const login = await http("/api/login", { method: "POST", body: { password } });
    if (login.status !== 200 || !login.cookie) refuse(`sign-in failed (${login.status})`);
    const page = await http("/dashboard", { cookie: login.cookie });
    if (page.status !== 200) refuse(`the dashboard answered ${page.status}`);
    say("");
    say(`SELFTEST PASS: ${build.commit.slice(0, 12)} answers on ${l.map((x) => `${x.address}:${PORT}`).join(", ")} only; sign-in and dashboard work without a database.`);
  } finally {
    await stopChild(child);
    if (!(await waitPortFree())) say(`WARNING: port ${PORT} is still in use after the self-test`);
  }
}

async function start(L) {
  const build = readBuild(L);
  say("Verifying Node.js, the source and app\\ against the build…");
  verifyApp(L, build);
  await verifyRuntime(L, build);
  if (!existsSync(L.env)) refuse("refusing: no private\\gate-f.env; run gate-f.cmd prepare first");
  const acl = ownerOnly(L.env, L.root);
  if (!acl.ok) refuse(`refusing: private\\gate-f.env is not private to you (${acl.reason}); run gate-f.cmd prepare again in a new folder`);
  const { vars, rehearsal, expired } = parseEnvFile(readFileSync(L.env, "utf8"));
  if (await portBusy(PORT)) refuse(`refusing: port ${PORT} is in use; stop the other server first (gate-f.cmd stop)`);

  rmSync(L.pid, { force: true }); // a record left by a closed window: the port is free, so it is stale
  const child = launch(L, serverEnv(L, build, vars));
  writeFileSync(L.pid, JSON.stringify({ pid: child.pid, launcher: process.pid, port: PORT, startedAt: new Date().toISOString() }), { flag: "wx" });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    say("Stopping…");
    await stopChild(child);
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(s, shutdown);
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  try {
    await waitReady(child);
    const l = await checkIdentityAndListener(build, child);
    const login = await http("/api/login", { method: "POST", body: { password: vars.H2G_PASSWORD } });
    if (login.status !== 200 || !login.cookie) refuse(`sign-in failed (${login.status})`);
    const g = await http("/api/strict/gate-f", { cookie: login.cookie });
    const a = g.data?.authorization;
    const sg = g.data?.safeguards;
    if (g.status !== 200 || g.data?.gateF !== true) refuse(`refusing: the server is not in gate F mode: ${g.data?.reason ?? g.status}`);
    if (a?.hevyId !== vars.H2G_GATE_F_HEVY_ID || String(a?.activityId) !== vars.H2G_GATE_F_GARMIN_ACTIVITY_ID || a?.synthetic !== rehearsal) refuse("refusing: the server's authorization differs from the env file");
    if (!sg?.firewall?.installed) refuse("refusing: the Garmin write firewall is not installed");
    if (!sg?.schema?.ready || !sg?.schema?.gateFTable) refuse("refusing: the database schema is not ready");
    say("");
    say(`READY ${rehearsal ? "(synthetic rehearsal) " : ""}http://127.0.0.1:${PORT}`);
    say(`  commit ${build.commit}, build manifest ${build.filesSha256.slice(0, 16)}…, Node ${process.version}`);
    say(`  listening on ${l.map((x) => x.address).join(", ")} only; firewall installed; gate F for Hevy ${a.hevyId} → Garmin ${a.activityId}, ${expired ? "EXPIRED (preview, evidence and restore only)" : `valid until ${a.expiresAt}`}`);
    say("  Sign in with the dashboard password from prepare. Stop with Ctrl+C in this window (or gate-f.cmd stop).");
  } catch (e) {
    await shutdown();
    rmSync(L.pid, { force: true });
    throw e;
  }
  const code = await exited;
  rmSync(L.pid, { force: true });
  await waitPortFree();
  say(`Server stopped (exit ${code ?? "signal"}).`);
}

async function stop(L) {
  if (!existsSync(L.pid)) {
    say("No server record; nothing to stop.");
    return;
  }
  const rec = JSON.parse(readFileSync(L.pid, "utf8"));
  if (!(await portBusy(PORT))) {
    // Window closed, reboot or crash: nothing of ours runs, and the PID may belong to anything now.
    rmSync(L.pid, { force: true });
    say("The server is not running (stale record removed).");
    return;
  }
  if (IS_WIN) {
    const owners = listeners(PORT).map((x) => x.pid);
    if (!owners.length || owners.some((o) => o !== rec.pid)) refuse(`refusing: port ${PORT} is held by another process; not stopping anything`);
    spawnSync(sys("taskkill"), ["/PID", String(rec.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const free = await waitPortFree();
  rmSync(L.pid, { force: true });
  if (!free) refuse(`port ${PORT} is still in use`);
  say("Server stopped; port 8096 is free.");
}

// ---------------------------------------------------------------- prepare

async function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) refuse(`refusing: ${question.trim()} needs an interactive window`);
  process.stdout.write(question);
  return new Promise((res) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return res(value.trim());
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            if (!hidden) process.stdout.write("\b \b");
          }
          continue;
        }
        value += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    stdin.on("data", onData);
  });
}

async function checkDatabase(L, url, { rehearsal }) {
  const require = createRequire(join(L.src, "web", "package.json"));
  const postgres = require("postgres");
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, idle_timeout: 2, onnotice: () => {} });
  try {
    // TLS: the connection itself is the proof (sslmode=verify-full refuses anything but a
    // verified certificate for the host). The server side may legitimately see no TLS behind
    // Neon's proxy or pooler, so pg_stat_ssl is not asked.
    const [row] = await sql`
      SELECT current_database() AS db,
        (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS relations`;
    if (row.relations !== 0) refuse(`refusing: database ${row.db} is not empty (${row.relations} objects in schema public); gate F needs a new, empty database`);
    return row.db;
  } catch (e) {
    if (e.refusal) throw e;
    const how = rehearsal ? "the local rehearsal database" : "this database with a verified TLS connection";
    refuse(`refusing: cannot use ${how}: ${e.code ?? ""} ${e.message}`.replace(/postgres(ql)?:\/\/[^\s]*/g, "<connection string>"));
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function prepare(L, { rehearsal }) {
  readBuild(L);
  if (existsSync(L.env)) refuse("refusing: private\\gate-f.env already exists. One authorization per folder: keep it, or archive it and use a new folder");
  let url;
  let hevyId;
  let activityId;
  let password;
  let expires;
  if (rehearsal) {
    url = normalizeDatabaseUrl(process.env.GATE_F_REHEARSAL_DATABASE_URL ?? "", { rehearsal: true });
    hevyId = "syn-legs";
    activityId = "9100001";
    const given = process.env.GATE_F_REHEARSAL_PASSWORD;
    if (given !== undefined && given.length < 16) refuse("refusing: GATE_F_REHEARSAL_PASSWORD must have at least 16 characters");
    password = given;
    expires = isoSeconds(Date.now() + 3 * 3600e3);
  } else {
    say("Gate F authorization: one Hevy workout into one Garmin activity, nothing else.");
    // Typed in this window only: never taken from a variable someone may have set beforehand.
    const preset = ["GATE_F_DATABASE_URL", "GATE_F_HEVY_ID", "GATE_F_GARMIN_ACTIVITY_ID"].filter((k) => process.env[k]);
    if (preset.length) refuse(`refusing: ${preset.join(", ")} set in this window; gate F asks for them itself`);
    url = normalizeDatabaseUrl(await ask("Connection string of the NEW, empty Neon database (input hidden): ", { hidden: true }));
    hevyId = await ask("Hevy workout id (from the workout's link): ");
    if (!ID_HEVY.test(hevyId) || hevyId.startsWith("syn-")) refuse("refusing: not a Hevy workout id");
    activityId = await ask("Garmin activity id (connect.garmin.com/modern/activity/<id>): ");
    if (!ID_GARMIN.test(activityId)) refuse("refusing: not a Garmin activity id");
    const days = process.env.GATE_F_DAYS ?? "3";
    if (!/^([1-9]|1[0-4])$/.test(days)) refuse("refusing: GATE_F_DAYS must be 1-14");
    expires = isoSeconds(Date.now() + Number(days) * 86400e3);
  }
  say(rehearsal ? "Checking the local rehearsal database (empty)…" : "Checking the database (verified TLS, empty)…");
  const db = await checkDatabase(L, url, { rehearsal });
  const secrets = newSecrets();
  if (password) secrets.H2G_PASSWORD = password;
  if (rehearsal) delete secrets.H2G_CREDENTIALS_KEY;
  const vars = {
    DATABASE_URL: url,
    ...secrets,
    ...(rehearsal ? {} : { H2G_DIRECT_GARMIN_LOGIN: "1" }),
    H2G_UPDATE_CHECK: "off",
    H2G_GATE_F: "approved-by-owner",
    H2G_GATE_F_HEVY_ID: hevyId,
    H2G_GATE_F_GARMIN_ACTIVITY_ID: activityId,
    H2G_GATE_F_EXPIRES: expires,
    ...(rehearsal ? { H2G_STAGING: "synthetic" } : {}),
  };
  const text = envFileText(vars, { rehearsal });
  parseEnvFile(text); // the file start will accept, or nothing is written
  mkdirSync(L.priv, { recursive: true });
  restrict(L.priv, "full");
  writeFileSync(L.env, text, { flag: "wx", mode: 0o600 });
  restrict(L.env, "full");
  const acl = ownerOnly(L.env, L.root);
  if (!acl.ok) {
    rmSync(L.env, { force: true });
    refuse(`refusing: could not make private\\gate-f.env private (${acl.reason})`);
  }
  say("");
  say(`Wrote private\\gate-f.env (${rehearsal ? "synthetic rehearsal" : `database ${db}`}, Hevy ${hevyId} → Garmin ${activityId}, valid until ${expires}).`);
  say(`Dashboard password: ${secrets.H2G_PASSWORD}`);
  if (!rehearsal) say("Keep the file and this password in your password manager; H2G_CREDENTIALS_KEY in it is needed again at gate G.");
  say("Next: gate-f.cmd start");
}

async function status(L) {
  if (!existsSync(L.build)) {
    say("No build yet.");
    return;
  }
  const b = readBuild(L);
  say(`Build: ${b.commit}, ${b.platform}, Node ${b.node.version}, built ${b.builtAt}`);
  say(`  source manifest SHA-256 ${b.sourceManifestSha256}`);
  say(`  build manifest  SHA-256 ${b.filesSha256}`);
  if (existsSync(L.env)) {
    try {
      const { vars, rehearsal, expired } = parseEnvFile(readFileSync(L.env, "utf8"));
      say(`Authorization: ${rehearsal ? "synthetic rehearsal" : "real"}, Hevy ${vars.H2G_GATE_F_HEVY_ID} → Garmin ${vars.H2G_GATE_F_GARMIN_ACTIVITY_ID}, ${expired ? "expired" : "valid until"} ${vars.H2G_GATE_F_EXPIRES}`);
    } catch (e) {
      say(`Authorization file present but not usable: ${e.message}`);
    }
  } else say("Authorization: none yet (gate-f.cmd prepare).");
  say(existsSync(L.pid) && (await portBusy(PORT)) ? "Server: running (gate-f.cmd stop to stop it)." : "Server: not running.");
}

// ---------------------------------------------------------------- main

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const L = layout(resolve(process.cwd()));
  preflight(L);
  switch (cmd) {
    case "build":
      return build(L, { commit: flag("--commit"), from: flag("--from") });
    case "selftest":
      return selftest(L);
    case "prepare":
      return prepare(L, { rehearsal: rest.includes("--rehearsal") });
    case "start":
      return start(L);
    case "stop":
      return stop(L);
    case "status":
      return status(L);
    default:
      refuse("usage: gate-f.cmd setup <commit> | selftest | prepare | start | stop | status");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`\n${e.refusal ? e.message : `ERROR: ${e.stack ?? e.message}`}\n`);
      process.exit(1);
    },
  );
}
