#!/usr/bin/env node
/**
 * Encrypted database backups (docs/STRICT_OPERATIONS.md §5).
 *
 *   pg_dump --format=custom --no-owner "$DATABASE_URL" | node scripts/backup-crypt.mjs encrypt - h2g.dump.h2gbak
 *   node scripts/backup-crypt.mjs decrypt h2g.dump.h2gbak h2g.dump
 *   node scripts/backup-crypt.mjs verify  h2g.dump.h2gbak
 *
 * Key: H2G_BACKUP_KEY, base64 of 32 random bytes (`openssl rand -base64 32`),
 * kept apart from the deployment (a password manager, not Vercel). It must not
 * equal H2G_CREDENTIALS_KEY or any other deployment secret: a backup that the
 * deployment's own key opens is not a separate line of defence. Previous
 * backup keys can be given in H2G_BACKUP_KEYS_PREVIOUS (comma separated) to
 * decrypt older files.
 *
 * File format (v1):
 *   "H2GBAK1\n" | header JSON + "\n" | ciphertext | 16-byte GCM tag
 * The magic and header are the AAD, so a changed header (key id, IV, created)
 * fails authentication. Decryption streams to "<out>.partial" and renames it
 * only after the tag has verified; on any failure the partial file is removed
 * and the exit code is non-zero. The tool never prints key material.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform, Writable } from "node:stream";

const MAGIC = Buffer.from("H2GBAK1\n", "utf8");
const TAG_LEN = 16;
const MAX_HEADER = 4096;

class BackupError extends Error {}

function decodeKey(raw, name) {
  const key = Buffer.from(String(raw).trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new BackupError(`${name} must be base64 of exactly 32 random bytes`);
  return key;
}

const kidOf = (key) => createHash("sha256").update("h2g-backup-kid:").update(key).digest("hex").slice(0, 16);

export function backupKeyring(env = process.env) {
  const raw = env.H2G_BACKUP_KEY?.trim();
  if (!raw) throw new BackupError("H2G_BACKUP_KEY is not set");
  for (const other of ["H2G_CREDENTIALS_KEY", "HEVY2GARMIN_SECRET", "H2G_SECRET", "CRON_SECRET", "H2G_PASSWORD"]) {
    if (env[other]?.trim() && env[other].trim() === raw) throw new BackupError(`H2G_BACKUP_KEY must be its own secret, not the same value as ${other}`);
  }
  const current = decodeKey(raw, "H2G_BACKUP_KEY");
  const byKid = new Map([[kidOf(current), current]]);
  for (const r of (env.H2G_BACKUP_KEYS_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = decodeKey(r, "H2G_BACKUP_KEYS_PREVIOUS");
    byKid.set(kidOf(k), k);
  }
  return { current, kid: kidOf(current), byKid };
}

const input = (path) => (path === "-" ? process.stdin : createReadStream(path));

export async function encryptFile(inPath, outPath, env = process.env) {
  const ring = backupKeyring(env);
  const iv = randomBytes(12);
  const header = Buffer.from(`${JSON.stringify({ v: 1, alg: "aes-256-gcm", kid: ring.kid, iv: iv.toString("base64"), created: new Date().toISOString() })}\n`, "utf8");
  const cipher = createCipheriv("aes-256-gcm", ring.current, iv);
  cipher.setAAD(Buffer.concat([MAGIC, header]));
  const partial = `${outPath}.partial`;
  try {
    const out = createWriteStream(partial, { mode: 0o600 });
    out.write(MAGIC);
    out.write(header);
    // Append the tag once the cipher has flushed.
    const withTag = new Transform({
      transform(chunk, _enc, cb) {
        cb(null, chunk);
      },
      flush(cb) {
        cb(null, cipher.getAuthTag());
      },
    });
    await pipeline(input(inPath), cipher, withTag, out);
    renameSync(partial, outPath);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
}

function readHeader(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, MAGIC.length + MAX_HEADER));
    readSync(fd, head, 0, head.length, 0);
    if (size < MAGIC.length + TAG_LEN + 2 || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("not an h2g encrypted backup");
    const nl = head.indexOf(0x0a, MAGIC.length);
    if (nl < 0) throw new BackupError("backup header is damaged");
    const headerBuf = head.subarray(MAGIC.length, nl + 1);
    let header;
    try {
      header = JSON.parse(headerBuf.toString("utf8"));
    } catch {
      throw new BackupError("backup header is damaged");
    }
    if (header?.v !== 1 || header?.alg !== "aes-256-gcm" || typeof header.kid !== "string" || typeof header.iv !== "string") {
      throw new BackupError("unsupported backup format");
    }
    const tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    const bodyStart = MAGIC.length + headerBuf.length;
    if (size - TAG_LEN < bodyStart) throw new BackupError("backup is truncated");
    return { header, headerBuf, tag, bodyStart, bodyEnd: size - TAG_LEN - 1, size };
  } finally {
    closeSync(fd);
  }
}

/** Decrypt to outPath (or only authenticate when outPath is null). Throws on a wrong key, a changed byte or truncation. */
export async function decryptFile(inPath, outPath, env = process.env) {
  const ring = backupKeyring(env);
  const { header, headerBuf, tag, bodyStart, bodyEnd } = readHeader(inPath);
  const key = ring.byKid.get(header.kid);
  if (!key) throw new BackupError(`no key for backup key id ${header.kid}; add it to H2G_BACKUP_KEYS_PREVIOUS`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
  decipher.setAAD(Buffer.concat([MAGIC, headerBuf]));
  decipher.setAuthTag(tag);
  const body = bodyEnd >= bodyStart ? createReadStream(inPath, { start: bodyStart, end: bodyEnd }) : Readable.from([]);
  const partial = outPath ? `${outPath}.partial` : null;
  try {
    const sink = partial
      ? createWriteStream(partial, { mode: 0o600 })
      : new Writable({ write: (_c, _e, cb) => cb() });
    await pipeline(body, decipher, sink);
    if (partial) renameSync(partial, outPath);
  } catch {
    if (partial) rmSync(partial, { force: true });
    throw new BackupError("backup failed authentication (wrong key, changed or truncated file)");
  }
  return { kid: header.kid, created: header.created };
}

async function main(argv) {
  const [cmd, a, b] = argv;
  try {
    if (cmd === "encrypt" && a && b) {
      await encryptFile(a, b);
      console.log(`encrypted → ${b}`);
    } else if (cmd === "decrypt" && a && b) {
      const r = await decryptFile(a, b);
      console.log(`decrypted (key ${r.kid}, created ${r.created}) → ${b}`);
    } else if (cmd === "verify" && a) {
      const r = await decryptFile(a, null);
      console.log(`authentic (key ${r.kid}, created ${r.created})`);
    } else {
      console.error("usage: backup-crypt.mjs encrypt <in|-> <out> | decrypt <in> <out> | verify <in>");
      process.exit(2);
    }
  } catch (e) {
    console.error(`backup-crypt: ${e instanceof BackupError ? e.message : e?.message ?? e}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
