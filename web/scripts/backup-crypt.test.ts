/**
 * Encrypted backups (review round 2, finding 4): round trip, and every way a
 * backup can be wrong fails without leaving an output file. Synthetic bytes.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { backupKeyring, decryptFile, encryptFile } from "./backup-crypt.mjs";

const dir = mkdtempSync(join(tmpdir(), "h2g-bk-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const key = () => randomBytes(32).toString("base64");
const env = { H2G_BACKUP_KEY: key() };
const plain = randomBytes(70_000);
const at = (n: string) => join(dir, n);

async function sealed(name: string) {
  writeFileSync(at(`${name}.plain`), plain);
  await encryptFile(at(`${name}.plain`), at(`${name}.bak`), env, { raw: true });
  return readFileSync(at(`${name}.bak`));
}

describe("backup-crypt", () => {
  it("round-trips, and the file holds none of the plaintext", async () => {
    const enc = await sealed("rt");
    expect(enc.subarray(0, 8).toString()).toBe("H2GBAK1\n");
    expect(enc.includes(plain.subarray(1000, 1064))).toBe(false);
    await decryptFile(at("rt.bak"), at("rt.out"), env, { raw: true });
    expect(readFileSync(at("rt.out")).equals(plain)).toBe(true);
  });

  it.each([
    ["a changed ciphertext byte", (b: Buffer) => { b[b.length >> 1] ^= 1; return b; }],
    ["a changed tag", (b: Buffer) => { b[b.length - 1] ^= 1; return b; }],
    ["a changed header (created date)", (b: Buffer) => Buffer.from(b.toString("latin1").replace(/"created":"\d/, (m) => m.slice(0, -1) + (m.endsWith("1") ? "2" : "1")), "latin1")],
    ["a truncated file", (b: Buffer) => b.subarray(0, b.length - 40)],
  ])("refuses %s and leaves no output", async (name, tamper) => {
    const enc = await sealed(`t${name.length}`);
    const file = at(`tampered-${name.length}.bak`);
    writeFileSync(file, tamper(Buffer.from(enc)));
    const out = at(`tampered-${name.length}.out`);
    await expect(decryptFile(file, out, env, { raw: true })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it("refuses a wrong key, and opens with a previous key after rotation", async () => {
    await sealed("rot");
    await expect(decryptFile(at("rot.bak"), at("rot.wrong"), { H2G_BACKUP_KEY: key() }, { raw: true })).rejects.toThrow(/no key for backup key id/);
    await decryptFile(at("rot.bak"), at("rot.ok"), { H2G_BACKUP_KEY: key(), H2G_BACKUP_KEYS_PREVIOUS: env.H2G_BACKUP_KEY }, { raw: true });
    expect(readFileSync(at("rot.ok")).equals(plain)).toBe(true);
  });

  it("refuses an empty input and anything that is not a pg_dump archive (re-audit #2)", async () => {
    writeFileSync(at("empty.plain"), Buffer.alloc(0));
    await expect(encryptFile(at("empty.plain"), at("empty.bak"), env, { raw: true })).rejects.toThrow(/empty/);
    expect(existsSync(at("empty.bak"))).toBe(false);
    writeFileSync(at("text.plain"), "not a dump");
    await expect(encryptFile(at("text.plain"), at("text.bak"), env)).rejects.toThrow(/pg_dump/);
    expect(existsSync(at("text.bak"))).toBe(false);
    writeFileSync(at("dump.plain"), Buffer.concat([Buffer.from("PGDMP"), randomBytes(500)]));
    await encryptFile(at("dump.plain"), at("dump.bak"), env);
    await decryptFile(at("dump.bak"), null, env); // verify: a pg_dump archive inside
    // A raw file is not accepted as a database backup at verify time.
    await expect(decryptFile(at("rt.bak"), null, env)).rejects.toThrow(/pg_dump/);
  });

  it("refuses a key that re-uses the credential key or another secret", () => {
    const k = key();
    for (const other of ["H2G_CREDENTIALS_KEY", "HEVY2GARMIN_SECRET", "CRON_SECRET"]) {
      expect(() => backupKeyring({ H2G_BACKUP_KEY: k, [other]: k })).toThrow(new RegExp(other));
    }
    expect(() => backupKeyring({ H2G_BACKUP_KEY: "short" })).toThrow(/32 random bytes/);
  });
});
