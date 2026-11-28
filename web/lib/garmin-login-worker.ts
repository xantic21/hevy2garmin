/**
 * The Garmin direct-login Worker client lives in garmin-auth (sso-worker):
 * Garmin blocks the login and token exchange from cloud IPs, so the web sends
 * the user's credentials to the Worker on Cloudflare's edge and stores the DI
 * tokens it returns. This module only picks the Worker URL for this deploy
 * (GARMIN_LOGIN_WORKER_URL, else the ecosystem's shared deploy) and keeps the
 * names the two login routes call.
 *
 * With H2G_DIRECT_GARMIN_LOGIN on, the same client runs the Worker's own code in this process
 * instead (garmin-auth/sso-local), so the email, password and code go only to Garmin, and no
 * Worker URL is used, GARMIN_LOGIN_WORKER_URL included (#685).
 */
import { createSsoWorkerClient, tokensFromResult, DEFAULT_SSO_WORKER_URL, type SsoFetch, type SsoWorkerClient, type WorkerLoginResult } from "garmin-auth/sso-worker";
import { createLocalSsoClient } from "garmin-auth/sso-local";
import { directGarminLogin } from "./direct-login-flag";

export { tokensFromResult };
export type { WorkerLoginResult, WorkerLoginStatus, GarminDiTokens } from "garmin-auth/sso-worker";
export type FetchImpl = SsoFetch;
export const DEFAULT_GARMIN_LOGIN_WORKER_URL = DEFAULT_SSO_WORKER_URL;

// One per process: its in-memory session store carries a pending MFA step from the password
// step to the code step.
let localClient: SsoWorkerClient | null = null;

/** The in-process sign-in client, for the login routes and the manual ticket exchange. */
export function localGarminLogin(): SsoWorkerClient {
  localClient ??= createLocalSsoClient();
  return localClient;
}

/**
 * The login Worker THIS deployment's owner configured, or null.
 *
 * Fork hardening: garmin-auth falls back to the upstream author's shared
 * Worker when no URL is set, which would send a user's Garmin email and
 * password to a third party by default. This fork never uses that fallback:
 * sign-in runs on this server (H2G_DIRECT_GARMIN_LOGIN) or through a Worker
 * the owner names explicitly in GARMIN_LOGIN_WORKER_URL, and otherwise fails
 * closed with an explanation.
 */
export function configuredLoginWorker(env: Record<string, string | undefined> = process.env): string | null {
  const url = (env.GARMIN_LOGIN_WORKER_URL ?? "").trim();
  return /^https:\/\/[^\s/]+/i.test(url) ? url.replace(/\/$/, "") : null;
}

export const NO_LOGIN_SERVICE =
  "No Garmin sign-in service is configured. Set H2G_DIRECT_GARMIN_LOGIN=1 (self-hosted) or GARMIN_LOGIN_WORKER_URL to your own Worker. Credentials are never sent to a shared third-party service.";

function refusingClient(): SsoWorkerClient {
  const refuse = async () => ({ status: "error" as const, message: NO_LOGIN_SERVICE });
  return { workerUrl: "", login: refuse, loginMfa: refuse, exchange: refuse } as unknown as SsoWorkerClient;
}

function client(fetchImpl?: FetchImpl) {
  if (directGarminLogin()) return localGarminLogin();
  const workerUrl = configuredLoginWorker();
  if (!workerUrl) return refusingClient();
  return createSsoWorkerClient({ workerUrl, fetchImpl });
}

/** The manual-ticket exchange, always run by this server so the browser never contacts a Worker. */
export function exchangeTicket(ticket: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).exchange(ticket) as Promise<WorkerLoginResult>;
}

/** Step 1: submit email + password. */
export function workerLogin(email: string, password: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).login(email, password);
}

/** Step 2 (only when step 1 returned needs_mfa): submit the verification code. */
export function workerLoginMfa(sessionId: string, mfaCode: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).loginMfa(sessionId, mfaCode);
}
