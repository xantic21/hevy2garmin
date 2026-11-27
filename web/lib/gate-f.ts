/**
 * Gate F: one owner-authorized real activity, and nothing else.
 *
 * The contract keeps production quarantined until after gate F, yet gate F
 * must write one real activity. This mode resolves that: it is a separate,
 * explicit owner authorization that lets this candidate run with exactly one
 * Hevy workout and exactly one native Garmin activity, through the strict
 * in-place merge only, and refuses everything else.
 *
 * Authorization (all four, exactly):
 *   H2G_GATE_F=approved-by-owner
 *   H2G_GATE_F_HEVY_ID=<the Hevy workout id>
 *   H2G_GATE_F_GARMIN_ACTIVITY_ID=<the native Garmin activity id>
 *   H2G_GATE_F_EXPIRES=<ISO-8601 time with zone, at most 14 days ahead>
 *
 * Separate from gate G: gate F refuses to run with H2G_PRODUCTION_CUTOVER or
 * H2G_STRICT_AUTOMATIC set, and gate G (the cutover) is a different variable.
 * Any malformed or contradictory authorization stops the whole server (the
 * runtime quarantine answers 503). An expired one keeps the server readable
 * and allows the recovery of the authorized activity, but no new merge.
 *
 * Edge-safe: no imports, so the proxy and instrumentation can use it.
 */
type Env = Record<string, string | undefined>;

export const GATE_F_ACK = "approved-by-owner";
export const GATE_F_MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const GATE_F_VARS = ["H2G_GATE_F", "H2G_GATE_F_HEVY_ID", "H2G_GATE_F_GARMIN_ACTIVITY_ID", "H2G_GATE_F_EXPIRES"] as const;

/**
 * Variables gate F refuses: real credentials kept in plain environment (the
 * authorized run uses only the sealed vault), anything that turns on gate G or
 * automatic sync, and the public read-only demo.
 */
export const GATE_F_FORBIDDEN_ENV = [
  "HEVY_API_KEY",
  "GITHUB_PAT",
  "GARMIN_EMAIL",
  "GARMIN_PASSWORD",
  "COLLECTOR_URL",
  "COLLECTOR_TOKEN",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "H2G_STRICT_AUTOMATIC",
  "H2G_PRODUCTION_CUTOVER",
  "DEMO_MODE",
] as const;

/** The synthetic id space of the staging simulator (lib/staging-fixtures.ts). */
const SYNTHETIC_ACTIVITY = { min: 9_100_000, max: 9_199_999 };

export interface GateFAuthorization {
  hevyId: string;
  activityId: number;
  expiresAt: string;
  /** A rehearsal inside synthetic staging (gate E infrastructure, simulated Garmin). */
  synthetic: boolean;
}

export type GateFState =
  | { requested: false }
  | { requested: true; ok: false; error: string }
  | { requested: true; ok: true; auth: GateFAuthorization; expired: boolean };

const set = (env: Env, k: string) => (env[k] ?? "").trim() !== "";
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function gateFState(env: Env = process.env, now: Date = new Date()): GateFState {
  if (!GATE_F_VARS.some((k) => set(env, k))) return { requested: false };
  const refuse = (error: string): GateFState => ({ requested: true, ok: false, error });
  const missing = GATE_F_VARS.filter((k) => !set(env, k));
  if (missing.length) return refuse(`incomplete: ${missing.join(", ")} missing`);
  if (env.H2G_GATE_F!.trim() !== GATE_F_ACK) return refuse(`H2G_GATE_F must be exactly "${GATE_F_ACK}"`);

  const hevyId = env.H2G_GATE_F_HEVY_ID!.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(hevyId)) return refuse("H2G_GATE_F_HEVY_ID is not a workout id");
  const rawActivity = env.H2G_GATE_F_GARMIN_ACTIVITY_ID!.trim();
  const activityId = Number(rawActivity);
  if (!/^[1-9][0-9]{0,15}$/.test(rawActivity) || !Number.isSafeInteger(activityId)) {
    return refuse("H2G_GATE_F_GARMIN_ACTIVITY_ID is not an activity id");
  }
  const rawExpires = env.H2G_GATE_F_EXPIRES!.trim();
  const expiresMs = Date.parse(rawExpires);
  if (!ISO_WITH_ZONE.test(rawExpires) || !Number.isFinite(expiresMs)) {
    return refuse("H2G_GATE_F_EXPIRES must be an ISO-8601 time with a zone, e.g. 2026-12-01T20:00:00Z");
  }
  if (expiresMs - now.getTime() > GATE_F_MAX_WINDOW_MS) return refuse("H2G_GATE_F_EXPIRES is more than 14 days ahead");

  const forbidden = GATE_F_FORBIDDEN_ENV.filter((k) => set(env, k));
  if (forbidden.length) return refuse(`refuses to run with ${forbidden.join(", ")} set`);
  if (env.H2G_SYNC_MODE === "legacy_upstream" && env.H2G_LEGACY_UPSTREAM_ACK === "uploads-and-deletes-allowed") {
    return refuse("runs strict mode only: unset H2G_SYNC_MODE and H2G_LEGACY_UPSTREAM_ACK");
  }
  if (!set(env, "H2G_PASSWORD") && !set(env, "H2G_PASSWORD_HASH")) return refuse("needs the dashboard password (H2G_PASSWORD or H2G_PASSWORD_HASH)");

  const staging = (env.H2G_STAGING ?? "").trim() === "synthetic";
  const syntheticIds = hevyId.startsWith("syn-") && activityId >= SYNTHETIC_ACTIVITY.min && activityId <= SYNTHETIC_ACTIVITY.max;
  const syntheticAny = hevyId.startsWith("syn-") || (activityId >= SYNTHETIC_ACTIVITY.min && activityId <= SYNTHETIC_ACTIVITY.max);
  if (staging && !syntheticIds) return refuse("in synthetic staging only a synthetic workout and activity can be authorized");
  if (!staging && syntheticAny) return refuse("synthetic ids belong to staging; authorize the real workout and activity");
  // Outside staging the run reads the sealed vault only, so its key must be there.
  if (!staging && !set(env, "H2G_CREDENTIALS_KEY")) return refuse("needs H2G_CREDENTIALS_KEY: credentials are used sealed only");

  return {
    requested: true,
    ok: true,
    auth: { hevyId, activityId, expiresAt: new Date(expiresMs).toISOString(), synthetic: staging },
    expired: expiresMs <= now.getTime(),
  };
}

/** True when the deployment runs in gate F mode (valid authorization, expired or not). */
export function gateFMode(env: Env = process.env, now: Date = new Date()): boolean {
  const s = gateFState(env, now);
  return s.requested && s.ok;
}

/** Sync entry points that never run in gate F mode, for any method. */
const ALWAYS_LOCKED: RegExp[] = [
  /^\/api\/cron(\/|$)/,
  /^\/api\/sync(\/|$)/,
  /^\/api\/sync-one\/?$/,
  /^\/api\/sync-run\/?$/,
];

/** The only changes gate F accepts: sign-in, connecting the accounts, settings and mappings, the strict operator actions. */
const MUTATING_ALLOWED: RegExp[] = [
  /^\/api\/login\/?$/,
  /^\/api\/logout\/?$/,
  /^\/api\/logout-all\/?$/,
  /^\/api\/client-error\/?$/,
  /^\/api\/garmin-login\/?$/,
  /^\/api\/garmin-login-mfa\/?$/,
  /^\/api\/garmin-ticket\/?$/,
  /^\/api\/garmin-ticket-exchange\/?$/,
  /^\/api\/garmin-rate-limited\/?$/,
  /^\/api\/connect-hevy\/?$/,
  /^\/api\/settings\/?$/,
  /^\/api\/mapping\/?$/,
  /^\/api\/mapping\/delete\/?$/,
  /^\/api\/strict\/gate-f\/?$/,
  /^\/api\/strict\/freeze\/?$/,
  /^\/api\/strict\/restore\/?$/,
  /^\/api\/strict\/reconcile\/?$/,
  /^\/api\/strict\/resolve\/?$/,
  /^\/api\/strict\/credentials\/?$/,
  /^\/api\/staging\/seed\/?$/,
];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether gate F mode refuses this request before it reaches a route. */
export function gateFLockedPath(pathname: string, method: string): boolean {
  if (ALWAYS_LOCKED.some((r) => r.test(pathname))) return true;
  if (!MUTATING.has(method.toUpperCase())) return false;
  return !MUTATING_ALLOWED.some((r) => r.test(pathname));
}

export function gateFRefusalBody(): { ok: false; gateF: true; error: string } {
  return {
    ok: false,
    gateF: true,
    error: "Gate F mode: only the owner-authorized workout can be merged, through the gate F panel. Other syncs and changes are locked.",
  };
}
