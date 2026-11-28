/**
 * Synthetic staging (gate E): a deployment that runs the real strict engine,
 * ledger, firewall and dashboard against SYNTHETIC data only.
 *
 * Enabled by `H2G_STAGING=synthetic` (exactly). In that mode:
 *  - every request the strict firewall lets through goes to an in-process
 *    simulator of Hevy and Garmin Connect (lib/staging-simulator.ts) instead
 *    of the network; any other host is refused, so nothing leaves the process;
 *  - no credential is ever accepted or stored: sign-in, ticket, Hevy-key and
 *    GitHub-token routes answer 423, and the credential vault refuses writes;
 *  - the database must be a staging database: empty when first used (it is
 *    then marked), never one holding credentials or real sync history
 *    (lib/staging-guard.ts);
 *  - it refuses to start as a Vercel PRODUCTION deployment or outside strict
 *    mode.
 *
 * Edge-safe: no Node-only imports, so the proxy can use it.
 */
import { NextResponse } from "next/server";
import { STAGING_FORBIDDEN_ENV } from "./deploy-quarantine";

type Env = Record<string, string | undefined>;

export const STAGING_VALUE = "synthetic";
export const STAGING_MARKER_KEY = "h2g_staging";

export function stagingMode(env: Env = process.env): boolean {
  return (env.H2G_STAGING ?? "").trim() === STAGING_VALUE;
}

export class StagingIsolationError extends Error {
  readonly code = "STAGING_ISOLATION";
  constructor(message: string) {
    super(message);
    this.name = "StagingIsolationError";
  }
}

/**
 * Variables that carry (or reach with) a real credential, or turn on
 * something staging must never do. Staging refuses to start with any of them.
 */
export { STAGING_FORBIDDEN_ENV } from "./deploy-quarantine";

/** Throws when staging is switched on where it must not run. */
export function assertStagingEnvironment(env: Env = process.env): void {
  if (!stagingMode(env)) return;
  const present = STAGING_FORBIDDEN_ENV.filter((k) => (env[k] ?? "").trim() !== "");
  if (present.length) {
    throw new StagingIsolationError(`synthetic staging refuses to start with ${present.join(", ")} set: remove them from this deployment`);
  }
  if ((env.VERCEL_ENV ?? "").trim() === "production") {
    throw new StagingIsolationError("H2G_STAGING=synthetic must never run as a Vercel production deployment");
  }
  // The same test as strict-mode.ts syncMode(), repeated so this file stays engine-free.
  if (env.H2G_SYNC_MODE === "legacy_upstream" && env.H2G_LEGACY_UPSTREAM_ACK === "uploads-and-deletes-allowed") {
    throw new StagingIsolationError("synthetic staging runs strict mode only: unset H2G_SYNC_MODE and H2G_LEGACY_UPSTREAM_ACK");
  }
}

/**
 * Routes that would receive or forward a real credential. In staging they
 * answer 423 for every method (a key can travel in a GET query too) before
 * anything is read, so a password, token or key typed into a staging
 * deployment by mistake goes nowhere. The one exception is the read-only
 * vault status, GET /api/strict/credentials, which holds no value.
 */
const CREDENTIAL_PATHS: RegExp[] = [
  /^\/api\/garmin-login\/?$/,
  /^\/api\/garmin-login-mfa\/?$/,
  /^\/api\/garmin-ticket\/?$/,
  /^\/api\/garmin-ticket-exchange\/?$/,
  /^\/api\/connect-hevy\/?$/,
  /^\/api\/validate-hevy\/?$/,
  /^\/api\/setup-actions\/?$/,
  /^\/api\/toggle-autosync\/?$/,
  /^\/api\/strict\/credentials\/?$/,
];

export function stagingCredentialPath(pathname: string, method: string): boolean {
  if (method.toUpperCase() === "GET" && /^\/api\/strict\/credentials\/?$/.test(pathname)) return false;
  return CREDENTIAL_PATHS.some((r) => r.test(pathname));
}

export function stagingRefusal(feature = "This action"): NextResponse {
  return NextResponse.json(
    { ok: false, staging: true, error: `${feature} is disabled in the synthetic staging deployment: it never accepts or stores real credentials.` },
    { status: 423 },
  );
}
