import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialVaultError,
  ENVELOPE_VERSION,
  assertVaultWritable,
  encryptionRequired,
  isEnvelope,
  loadKeyring,
  open,
  peekStored,
  seal,
  type CredentialEnvelope,
} from "./credential-vault";

/**
 * The credential vault without a database: AES-256-GCM envelopes, key ids,
 * previous keys, the platform binding (AAD), tamper detection and the
 * fail-closed policy. Synthetic secrets only.
 */
const k = () => randomBytes(32).toString("base64");
const STRICT = { H2G_SYNC_MODE: "" };
const LEGACY = { H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" };
const SECRET = { api_key: "synthetic-hevy-key-0f9c" };

const flip = (b64: string, at = 0) => {
  const buf = Buffer.from(b64, "base64");
  buf[at] ^= 0x01;
  return buf.toString("base64");
};

describe("credential vault: envelopes", () => {
  it("round-trips, and the envelope holds no plaintext", () => {
    const ring = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    const env = seal("hevy", SECRET, ring);
    expect(env.h2g_enc).toBe(ENVELOPE_VERSION);
    expect(env.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(env)).not.toContain("synthetic-hevy-key");
    expect(open("hevy", env, ring)).toEqual(SECRET);
  });

  it("uses a fresh IV for every write (equal secrets never give equal ciphertexts)", () => {
    const ring = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    const a = seal("hevy", SECRET, ring);
    const b = seal("hevy", SECRET, ring);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("binds a row to its platform: a copied row fails authentication", () => {
    const ring = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    const env = seal("hevy", SECRET, ring);
    expect(() => open("garmin_tokens", env, ring)).toThrow(CredentialVaultError);
  });

  it.each([
    ["ciphertext", (e: CredentialEnvelope) => ({ ...e, ct: flip(e.ct) })],
    ["tag", (e: CredentialEnvelope) => ({ ...e, tag: flip(e.tag) })],
    ["iv", (e: CredentialEnvelope) => ({ ...e, iv: flip(e.iv) })],
    ["truncated ciphertext", (e: CredentialEnvelope) => ({ ...e, ct: Buffer.from(e.ct, "base64").subarray(1).toString("base64") })],
  ])("detects a changed %s", (_label, tamper) => {
    const ring = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    const env = seal("hevy", SECRET, ring);
    expect(() => open("hevy", tamper(env), ring)).toThrow(/failed authentication/);
  });

  it("refuses a wrong key and names the missing key id", () => {
    const env = seal("hevy", SECRET, loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() }));
    const other = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    expect(() => open("hevy", env, other)).toThrow(new RegExp(`no key for credential key id ${env.kid}`));
  });

  it("a forged key id that points at the current key still fails authentication", () => {
    const ring = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() });
    const env = seal("hevy", SECRET, loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k() }));
    expect(() => open("hevy", { ...env, kid: ring.current!.kid }, ring)).toThrow(/failed authentication/);
  });

  it("opens rows sealed under a previous key after rotation", () => {
    const old = k();
    const env = seal("garmin_tokens", { garmin_tokens: { di_token: "synthetic" } }, loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: old }));
    const rotated = loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k(), H2G_CREDENTIALS_KEYS_PREVIOUS: `${k()}, ${old}` });
    expect(rotated.current!.kid).not.toBe(env.kid);
    expect(open("garmin_tokens", env, rotated)).toEqual({ garmin_tokens: { di_token: "synthetic" } });
  });

  it("recognises only complete envelopes", () => {
    expect(isEnvelope({ h2g_enc: ENVELOPE_VERSION, kid: "x", iv: "x", tag: "x", ct: "x" })).toBe(true);
    expect(isEnvelope({ h2g_enc: ENVELOPE_VERSION, kid: "x", iv: "x", tag: "x" })).toBe(false);
    expect(isEnvelope({ api_key: "x" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});

describe("credential vault: key management", () => {
  it.each([["short", Buffer.alloc(16).toString("base64")], ["long", Buffer.alloc(48).toString("base64")], ["empty-ish", "AA=="]])(
    "refuses a %s key",
    (_l, key) => {
      expect(() => loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: key })).toThrow(/exactly 32 random bytes/);
    },
  );

  it("refuses a malformed previous key instead of ignoring it", () => {
    expect(() => loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: k(), H2G_CREDENTIALS_KEYS_PREVIOUS: "nope" })).toThrow(/H2G_CREDENTIALS_KEYS_PREVIOUS/);
  });

  it.each(["HEVY2GARMIN_SECRET", "H2G_SECRET", "CRON_SECRET", "H2G_PASSWORD", "H2G_BACKUP_KEY"])("refuses a key that re-uses %s", (name) => {
    const key = k();
    expect(() => loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: key, [name]: key })).toThrow(new RegExp(name));
  });

  it("accepts the url-safe base64 alphabet", () => {
    const key = randomBytes(32).toString("base64url");
    expect(loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: key }).current).not.toBeNull();
  });
});

describe("credential vault: policy", () => {
  it("requires encryption in strict mode, and whenever a key is set", () => {
    expect(encryptionRequired(STRICT)).toBe(true);
    expect(encryptionRequired({ ...LEGACY, H2G_CREDENTIALS_KEY: k() })).toBe(true);
    expect(encryptionRequired(LEGACY)).toBe(false);
  });

  it("refuses to accept a credential in strict mode without a key", () => {
    expect(() => assertVaultWritable(STRICT)).toThrow(/H2G_CREDENTIALS_KEY is not set/);
    expect(() => assertVaultWritable({ ...STRICT, H2G_CREDENTIALS_KEY: k() })).not.toThrow();
    expect(() => assertVaultWritable(LEGACY)).not.toThrow();
  });

  it("refuses to seal without a key", () => {
    expect(() => seal("hevy", SECRET, loadKeyring(STRICT))).toThrow(/not set/);
  });

  it("peekStored never throws and never treats an unusable value as usable", () => {
    const key = k();
    const env = seal("hevy", SECRET, loadKeyring({ ...STRICT, H2G_CREDENTIALS_KEY: key }));
    expect(peekStored("hevy", env, { ...STRICT, H2G_CREDENTIALS_KEY: key })).toEqual(SECRET);
    expect(peekStored("hevy", env, { ...STRICT, H2G_CREDENTIALS_KEY: k() })).toBeNull();
    expect(peekStored("hevy", { ...env, ct: flip(env.ct) }, { ...STRICT, H2G_CREDENTIALS_KEY: key })).toBeNull();
    expect(peekStored("hevy", JSON.stringify(env), { ...STRICT, H2G_CREDENTIALS_KEY: key })).toEqual(SECRET);
    // Plaintext: strict mode never uses it, key or not; legacy mode may.
    expect(peekStored("hevy", SECRET, STRICT)).toBeNull();
    expect(peekStored("hevy", SECRET, { ...STRICT, H2G_CREDENTIALS_KEY: key })).toBeNull();
    expect(peekStored("hevy", SECRET, LEGACY)).toBe("plaintext");
    expect(peekStored("hevy", SECRET, { ...LEGACY, H2G_CREDENTIALS_KEY: key })).toBe("plaintext");
    expect(peekStored("hevy", "not json", LEGACY)).toBeNull();
    expect(peekStored("hevy", SECRET, { ...STRICT, H2G_CREDENTIALS_KEY: "broken" })).toBeNull();
  });
});
