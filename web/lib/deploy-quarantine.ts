/**
 * The deployment quarantine at RUNTIME (the build gate alone can be bypassed,
 * e.g. by `vercel build` without VERCEL_ENV followed by `vercel deploy
 * --prebuilt --prod`). Checked when the server starts (instrumentation.ts)
 * and on every request (proxy.ts). Edge-safe: no imports.
 *
 *  - A Vercel PRODUCTION deployment runs only after the owner's separate,
 *    reviewed cutover: H2G_PRODUCTION_CUTOVER=approved-by-owner.
 *  - A Vercel PREVIEW runs only as synthetic staging (H2G_STAGING=synthetic).
 *  - Synthetic staging refuses to run with any real-credential variable set.
 */
type Env = Record<string, string | undefined>;

export const PRODUCTION_CUTOVER_ACK = "approved-by-owner";

export const STAGING_FORBIDDEN_ENV = [
  "HEVY_API_KEY",
  "GITHUB_PAT",
  "GARMIN_EMAIL",
  "GARMIN_PASSWORD",
  "GARMIN_LOGIN_WORKER_URL",
  "H2G_DIRECT_GARMIN_LOGIN",
  "H2G_CREDENTIALS_KEY",
  "H2G_CREDENTIALS_KEYS_PREVIOUS",
  "COLLECTOR_URL",
  "COLLECTOR_TOKEN",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "H2G_STRICT_AUTOMATIC",
] as const;

/**
 * Secrets that belong to the dashboard itself (sign-in and session seed, cron
 * bearer). Staging sets its own, staging-only values; they unlock nothing
 * outside the deployment. Every other credential-like variable the dashboard
 * reads must be in STAGING_FORBIDDEN_ENV (deploy-quarantine.test.ts checks
 * the source for drift).
 */
export const STAGING_OWN_SECRETS = ["H2G_PASSWORD", "H2G_PASSWORD_HASH", "H2G_SECRET", "HEVY2GARMIN_SECRET", "CRON_SECRET"] as const;

/** Why this process must not serve, or null. */
export function quarantineViolation(env: Env = process.env): string | null {
  const vercelEnv = (env.VERCEL_ENV ?? "").trim();
  const staging = (env.H2G_STAGING ?? "").trim() === "synthetic";
  if (vercelEnv === "production") {
    if (staging) return "synthetic staging must never run as a Vercel production deployment";
    if ((env.H2G_PRODUCTION_CUTOVER ?? "").trim() !== PRODUCTION_CUTOVER_ACK) {
      return "this migration candidate is quarantined: a production deployment needs the owner's approved cutover (H2G_PRODUCTION_CUTOVER)";
    }
  }
  if (vercelEnv === "preview" && !staging) return "a preview of this migration candidate runs only as synthetic staging (H2G_STAGING=synthetic)";
  if (staging) {
    const present = STAGING_FORBIDDEN_ENV.filter((k) => (env[k] ?? "").trim() !== "");
    if (present.length) return `synthetic staging refuses to run with ${present.join(", ")} set`;
  }
  return null;
}
