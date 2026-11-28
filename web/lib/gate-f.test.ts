/**
 * Gate F authorization, runtime quarantine and route policy (no database).
 * Every rule of lib/gate-f.ts as a positive and a negative case.
 */
import { describe, expect, it } from "vitest";
import { GATE_F_FORBIDDEN_ENV, GATE_F_MAX_WINDOW_MS, gateFLockedPath, gateFMode, gateFState, strictIsoMs } from "./gate-f";
import { quarantineViolation } from "./deploy-quarantine";
import { gateFRecoveryPin, gateFSyncRefusal } from "./strict-sync";

const NOW = new Date("2026-12-01T12:00:00Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

/** A valid real (off-Vercel) authorization. */
const REAL = {
  H2G_GATE_F: "approved-by-owner",
  H2G_GATE_F_HEVY_ID: "b1e2c3d4-0000-4a5b-8c9d-0123456789ab",
  H2G_GATE_F_GARMIN_ACTIVITY_ID: "21345678901",
  H2G_GATE_F_EXPIRES: inHours(24),
  H2G_PASSWORD: "owner-pass",
  H2G_CREDENTIALS_KEY: "k".repeat(44),
};
/** A valid synthetic rehearsal inside staging. */
const SYN = {
  H2G_STAGING: "synthetic",
  H2G_GATE_F: "approved-by-owner",
  H2G_GATE_F_HEVY_ID: "syn-legs",
  H2G_GATE_F_GARMIN_ACTIVITY_ID: "9100001",
  H2G_GATE_F_EXPIRES: inHours(2),
  H2G_PASSWORD: "staging-pass",
};

const error = (env: Record<string, string | undefined>) => {
  const s = gateFState(env, NOW);
  return s.requested && !s.ok ? s.error : null;
};

describe("gate F authorization", () => {
  it("is off when none of its variables is set", () => {
    expect(gateFState({}, NOW)).toEqual({ requested: false });
    expect(gateFMode({}, NOW)).toBe(false);
  });

  it("accepts the complete real authorization", () => {
    const s = gateFState(REAL, NOW);
    expect(s).toMatchObject({ requested: true, ok: true, expired: false, auth: { hevyId: REAL.H2G_GATE_F_HEVY_ID, activityId: 21345678901, synthetic: false } });
    expect(gateFMode(REAL, NOW)).toBe(true);
  });

  it("accepts the synthetic rehearsal inside staging (no credentials key needed there)", () => {
    expect(gateFState(SYN, NOW)).toMatchObject({ ok: true, auth: { synthetic: true, activityId: 9100001 } });
  });

  for (const k of ["H2G_GATE_F", "H2G_GATE_F_HEVY_ID", "H2G_GATE_F_GARMIN_ACTIVITY_ID", "H2G_GATE_F_EXPIRES"]) {
    it(`any single variable alone is refused as incomplete (${k} missing)`, () => {
      expect(error({ ...REAL, [k]: "" })).toMatch(new RegExp(`incomplete: ${k}`));
    });
  }

  for (const ack of ["yes", "approved", "Approved-By-Owner", "approved-by-owner!"]) {
    it(`refuses any acknowledgement but the exact one (${ack})`, () => {
      expect(error({ ...REAL, H2G_GATE_F: ack })).toMatch(/exactly/);
    });
  }

  for (const id of ["-abc", "a b", "x".repeat(65), "abc/def", "ab..cd", "<script>"]) {
    it(`refuses a malformed workout id ${JSON.stringify(id)}`, () => {
      expect(error({ ...REAL, H2G_GATE_F_HEVY_ID: id })).toMatch(/not a workout id/);
    });
  }

  for (const id of ["0", "-5", "12.5", "1e9", "0x1F", "9007199254740993", "12 34"]) {
    it(`refuses a malformed activity id ${JSON.stringify(id)}`, () => {
      expect(error({ ...REAL, H2G_GATE_F_GARMIN_ACTIVITY_ID: id })).toMatch(/not an activity id/);
    });
  }

  for (const exp of ["2026-12-02", "2026-12-02T10:00:00", "tomorrow", "2026-13-40T10:00:00Z"]) {
    it(`refuses an expiry without a valid time and zone (${exp})`, () => {
      expect(error({ ...REAL, H2G_GATE_F_EXPIRES: exp })).toMatch(/ISO-8601/);
    });
  }

  it("refuses an expiry more than 14 days ahead, accepts exactly 14 days", () => {
    expect(error({ ...REAL, H2G_GATE_F_EXPIRES: new Date(NOW.getTime() + GATE_F_MAX_WINDOW_MS + 60_000).toISOString() })).toMatch(/14 days/);
    expect(error({ ...REAL, H2G_GATE_F_EXPIRES: new Date(NOW.getTime() + GATE_F_MAX_WINDOW_MS).toISOString() })).toBeNull();
  });

  for (const exp of ["2026-11-31T12:00:00Z", "2026-02-29T12:00:00Z", "2026-12-02T24:00:00Z", "2026-12-02T10:60:00Z", "2026-12-02T10:00:00+23:59", "2026-12-02T10:00:00+14:01", "2026-12-02T10:00:00+01:60"]) {
    it(`refuses an impossible date or offset (${exp}) instead of rolling it over (re-audit #3, F4)`, () => {
      expect(Number.isNaN(strictIsoMs(exp))).toBe(true);
      expect(error({ ...REAL, H2G_GATE_F_EXPIRES: exp })).toMatch(/ISO-8601/);
    });
  }

  it("accepts real dates and offsets up to ±14:00", () => {
    for (const exp of ["2026-12-02T10:00:00Z", "2026-12-02T10:00Z", "2026-12-02T10:00:00.123Z", "2026-12-02T10:00:00+14:00", "2026-12-02T10:00:00-12:00", "2028-02-29T10:00:00Z"]) {
      expect(Number.isFinite(strictIsoMs(exp)), exp).toBe(true);
    }
  });

  for (const k of ["VERCEL_URL", "VERCEL_REGION", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "AWS_EXECUTION_ENV", "NETLIFY", "RENDER", "FLY_APP_NAME", "K_SERVICE", "DYNO"]) {
    it(`a real gate F refuses a hosting platform (${k} set; re-audit #3, F5)`, () => {
      expect(error({ ...REAL, [k]: "x" })).toMatch(/owner's own computer/);
      // A synthetic rehearsal inside staging may run on a hosted preview.
      expect(error({ ...SYN, [k]: "x" })).toBeNull();
    });
  }

  it("an expired authorization stays valid but expired (readable, recovery only)", () => {
    expect(gateFState({ ...REAL, H2G_GATE_F_EXPIRES: inHours(-1) }, NOW)).toMatchObject({ ok: true, expired: true });
  });

  for (const k of GATE_F_FORBIDDEN_ENV) {
    it(`refuses to run with ${k} set (plain credentials, gate G, automatic sync, demo)`, () => {
      expect(error({ ...REAL, [k]: "x" })).toMatch(new RegExp(k));
    });
  }

  it("refuses legacy mode, a missing password and (outside staging) a missing credentials key", () => {
    expect(error({ ...REAL, H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" })).toMatch(/strict mode only/);
    expect(error({ ...REAL, H2G_PASSWORD: "" })).toMatch(/password/);
    expect(error({ ...REAL, H2G_PASSWORD: "", H2G_PASSWORD_HASH: "$argon2id$..." })).toBeNull();
    expect(error({ ...REAL, H2G_CREDENTIALS_KEY: "" })).toMatch(/H2G_CREDENTIALS_KEY/);
  });

  it("keeps real and synthetic apart: staging only with synthetic ids, real only with real ids", () => {
    expect(error({ ...SYN, H2G_GATE_F_HEVY_ID: REAL.H2G_GATE_F_HEVY_ID })).toMatch(/synthetic/);
    expect(error({ ...SYN, H2G_GATE_F_GARMIN_ACTIVITY_ID: REAL.H2G_GATE_F_GARMIN_ACTIVITY_ID })).toMatch(/synthetic/);
    expect(error({ ...REAL, H2G_GATE_F_HEVY_ID: "syn-legs" })).toMatch(/synthetic ids belong to staging/);
    expect(error({ ...REAL, H2G_GATE_F_GARMIN_ACTIVITY_ID: "9100001" })).toMatch(/synthetic ids belong to staging/);
  });
});

describe("gate F in the runtime quarantine", () => {
  it("a real gate F runs only off Vercel", () => {
    expect(quarantineViolation(REAL, NOW)).toBeNull();
    for (const v of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL: "1" }]) {
      expect(quarantineViolation({ ...REAL, ...v }, NOW), JSON.stringify(v)).toMatch(/owner's own (machine|computer)/);
    }
  });

  it("the synthetic rehearsal runs in a staging preview, never as production", () => {
    expect(quarantineViolation({ ...SYN, VERCEL_ENV: "preview" }, NOW)).toBeNull();
    expect(quarantineViolation({ ...SYN, VERCEL_ENV: "production" }, NOW)).toMatch(/production/);
  });

  it("a malformed or contradictory authorization stops the server everywhere", () => {
    expect(quarantineViolation({ ...REAL, H2G_GATE_F_GARMIN_ACTIVITY_ID: "abc" }, NOW)).toMatch(/gate F authorization is refused/);
    expect(quarantineViolation({ H2G_GATE_F_HEVY_ID: "x" }, NOW)).toMatch(/incomplete/);
  });

  it("gate F and gate G never run together", () => {
    expect(quarantineViolation({ ...REAL, H2G_PRODUCTION_CUTOVER: "approved-by-owner" }, NOW)).toMatch(/H2G_PRODUCTION_CUTOVER/);
    expect(quarantineViolation({ ...REAL, H2G_STRICT_AUTOMATIC: "enabled-by-owner" }, NOW)).toMatch(/H2G_STRICT_AUTOMATIC/);
    // Gate G alone is unchanged.
    expect(quarantineViolation({ VERCEL_ENV: "production", H2G_PRODUCTION_CUTOVER: "approved-by-owner" }, NOW)).toBeNull();
  });

  it("an expired authorization does not stop the server (evidence and recovery stay reachable)", () => {
    expect(quarantineViolation({ ...REAL, H2G_GATE_F_EXPIRES: inHours(-2) }, NOW)).toBeNull();
  });
});

describe("gate F route policy", () => {
  it("locks every sync entry point for any method", () => {
    for (const p of ["/api/sync", "/api/sync/", "/api/sync/abc", "/api/sync/preview", "/api/sync-one", "/api/sync-run", "/api/cron/sync", "/api/cron/webhook", "/api/cron"]) {
      for (const m of ["GET", "POST"]) expect(gateFLockedPath(p, m), `${m} ${p}`).toBe(true);
    }
  });

  it("locks every other mutating route", () => {
    for (const p of ["/api/unsync-all", "/api/unsync/x", "/api/pending/x/retry", "/api/routines/sync", "/api/update-fork", "/api/toggle-autosync", "/api/setup-actions", "/api/workout/x/mark-synced", "/api/workout/x/skip", "/api/scan-duplicates", "/api/pull-garmin-profile", "/api/strict/gate-f/extra", "/api/strict/freeze/x"]) {
      expect(gateFLockedPath(p, "POST"), p).toBe(true);
      expect(gateFLockedPath(p, "DELETE"), p).toBe(true);
    }
  });

  it("leaves sign-in, account connection, settings, mappings and the strict operator routes open", () => {
    for (const p of ["/api/login", "/api/logout", "/api/garmin-login", "/api/garmin-login-mfa", "/api/garmin-ticket-exchange", "/api/connect-hevy", "/api/settings", "/api/mapping", "/api/mapping/delete", "/api/strict/gate-f", "/api/strict/freeze", "/api/strict/restore", "/api/strict/reconcile", "/api/strict/resolve", "/api/strict/credentials"]) {
      expect(gateFLockedPath(p, "POST"), p).toBe(false);
    }
    for (const p of ["/api/workouts", "/api/strict/status", "/api/strict/gate-f", "/api/strict/duplicate-audit", "/dashboard"]) expect(gateFLockedPath(p, "GET"), p).toBe(false);
  });
});

describe("gate F in the strict bindings", () => {
  const pin = { hevyId: REAL.H2G_GATE_F_HEVY_ID, activityId: 21345678901 };
  const env = { ...REAL, H2G_GATE_F_EXPIRES: new Date(Date.now() + 3_600_000).toISOString() };
  const expired = { ...REAL, H2G_GATE_F_EXPIRES: new Date(Date.now() - 60_000).toISOString() };

  it("only the exact pin may sync in gate F mode; a pin is refused outside it", () => {
    expect(gateFSyncRefusal({ dryRun: false, pin }, env)).toBeNull();
    expect(gateFSyncRefusal({ dryRun: false }, env)).toMatch(/only the authorized workout/);
    expect(gateFSyncRefusal({ dryRun: true, pin: { ...pin, activityId: 1 } }, env)).toMatch(/only the authorized workout/);
    expect(gateFSyncRefusal({ dryRun: false, pin: { ...pin, hevyId: "other" } }, env)).toMatch(/only the authorized workout/);
    expect(gateFSyncRefusal({ dryRun: false, pin }, {})).toMatch(/outside gate F mode/);
    expect(gateFSyncRefusal({ dryRun: false }, {})).toBeNull();
  });

  it("after expiry: preview yes, live no; recovery keeps the pin", () => {
    expect(gateFSyncRefusal({ dryRun: true, pin }, expired)).toBeNull();
    expect(gateFSyncRefusal({ dryRun: false, pin }, expired)).toMatch(/expired/);
    expect(gateFRecoveryPin(expired)).toEqual({ refusal: null, pin });
    expect(gateFRecoveryPin({})).toEqual({ refusal: null });
    expect(gateFRecoveryPin({ ...env, H2G_GATE_F: "nope" }).refusal).toMatch(/refused/);
  });
});
