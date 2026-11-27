/**
 * Strict mode's network boundary: a default-deny firewall in front of every
 * request this process sends to Garmin.
 *
 * Every Garmin call in this engine and in `garmin-auth` goes through the
 * global `fetch`, so wrapping it once at process start covers the sync engine,
 * the dashboard's own helpers (routines, deletes) and anything added later.
 * UI switches and engine options can be bypassed by a new code path; this
 * cannot, which is what contract item 2 asks for ("guard at the actual network
 * boundary, not just UI or mergeOnly").
 *
 * Policy, decided per request BEFORE any byte leaves the process:
 *   - Non-Garmin hosts pass through untouched (Hevy, the database, GitHub).
 *   - Garmin reads (GET/HEAD, no method override) pass.
 *   - Authentication (SSO, DI token exchange/refresh, OAuth service) passes:
 *     it changes no activity.
 *   - Exactly two writes can pass, and only inside a capability scope opened
 *     for that one activity id (`withGarminWriteCapability`):
 *       PUT /activity-service/activity/{id}/exerciseSets  body.activityId == id
 *       PUT /activity-service/activity/{id}               body keys ⊆
 *           {activityId, activityName, description}, body.activityId == id
 *   - Everything else is refused with StrictModeViolation, the network is never
 *     touched: FIT uploads, every DELETE, workout/calendar writes, gear, any
 *     other activity field, and any write outside its scope.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { StrictModeViolation } from "./errors";

export type GarminWriteKind = "exercise_sets" | "metadata";

export type GarminRequestClass =
  | { kind: "not_garmin" }
  | { kind: "read" }
  | { kind: "auth" }
  | { kind: "write"; write: GarminWriteKind; activityId: number }
  | { kind: "forbidden"; reason: string };

export interface GarminWriteScope {
  readonly activityId: number;
  readonly allow: ReadonlySet<GarminWriteKind>;
}

const scopeStore = new AsyncLocalStorage<GarminWriteScope>();

/** Garmin's own hosts: garmin.com, garmin.cn and every subdomain. */
const GARMIN_HOST = /(^|\.)garmin\.(com|cn)$/i;
const AUTH_HOSTS = /^(sso|diauth)\.garmin\.(com|cn)$/i;
const SETS_PATH = /^\/activity-service\/activity\/(\d+)\/exerciseSets\/?$/;
const ACTIVITY_PATH = /^\/activity-service\/activity\/(\d+)\/?$/;
const METADATA_KEYS = new Set(["activityId", "activityName", "description"]);

function urlOf(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as Request).url));
  } catch {
    return null;
  }
  return null;
}

function headerOf(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted) return String(pair[1]);
    }
    return null;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === wanted) return v == null ? null : String(v);
    }
  }
  return null;
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> | null {
  const body = init?.body;
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify one request. Pure; exported so the policy itself is unit-tested.
 * A `Request` object passed as `input` with no `init` is classified from its
 * own method and headers, but its body cannot be inspected synchronously, so
 * a write sent that way is forbidden.
 */
export function classifyGarminRequest(input: unknown, init?: RequestInit): GarminRequestClass {
  const url = urlOf(input);
  if (!url) return { kind: "not_garmin" };
  if (!GARMIN_HOST.test(url.hostname)) return { kind: "not_garmin" };

  const req = input && typeof input === "object" && "method" in (input as object) ? (input as Request) : null;
  const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
  const override = headerOf(init?.headers ?? req?.headers, "X-HTTP-Method-Override");
  const effective = (override ?? method).toUpperCase();
  const isRead = (method === "GET" || method === "HEAD") && (effective === "GET" || effective === "HEAD");

  if (AUTH_HOSTS.test(url.hostname)) return { kind: "auth" };
  if (url.pathname.startsWith("/oauth-service/oauth/") || url.pathname.startsWith("/di-oauth2-service/oauth/")) {
    return { kind: "auth" };
  }
  if (isRead) return { kind: "read" };

  if (effective === "PUT") {
    const sets = SETS_PATH.exec(url.pathname);
    const activity = ACTIVITY_PATH.exec(url.pathname);
    const match = sets ?? activity;
    if (match) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return { kind: "forbidden", reason: "invalid activity id" };
      const body = jsonBody(init);
      if (!body) return { kind: "forbidden", reason: "write body is not inspectable JSON" };
      if (Number(body.activityId) !== id) {
        return { kind: "forbidden", reason: "body activityId does not match the path" };
      }
      if (sets) return { kind: "write", write: "exercise_sets", activityId: id };
      const extra = Object.keys(body).filter((k) => !METADATA_KEYS.has(k));
      if (extra.length) return { kind: "forbidden", reason: `activity fields not allowed: ${extra.join(", ")}` };
      return { kind: "write", write: "metadata", activityId: id };
    }
  }
  return { kind: "forbidden", reason: `${effective} ${url.pathname} is not allowed in strict mode` };
}

/**
 * Run `fn` with permission to write `allow` onto ONE activity. Nested scopes
 * replace the outer one; nothing leaks to concurrent requests, because the
 * scope lives in AsyncLocalStorage rather than a module variable.
 */
export function withGarminWriteCapability<T>(scope: GarminWriteScope, fn: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(scope.activityId) || scope.activityId <= 0) {
    return Promise.reject(new StrictModeViolation("capability requires a valid activity id"));
  }
  return scopeStore.run(Object.freeze({ activityId: scope.activityId, allow: new Set(scope.allow) }), fn);
}

export function currentWriteScope(): GarminWriteScope | undefined {
  return scopeStore.getStore();
}

export interface FirewallEvent {
  at: string;
  verdict: "blocked";
  reason: string;
  method: string;
  host: string;
  path: string;
}

const recent: FirewallEvent[] = [];
let blockedCount = 0;

/** Blocked attempts since process start, for the dashboard's health panel. */
export function firewallStats(): { blocked: number; recent: FirewallEvent[] } {
  return { blocked: blockedCount, recent: recent.slice() };
}

function block(input: unknown, init: RequestInit | undefined, reason: string): never {
  const url = urlOf(input);
  blockedCount += 1;
  recent.unshift({
    at: new Date().toISOString(),
    verdict: "blocked",
    reason,
    method: String(init?.method ?? "GET").toUpperCase(),
    host: url?.hostname ?? "?",
    // The path only: query strings can carry tokens.
    path: url?.pathname ?? "?",
  });
  recent.length = Math.min(recent.length, 20);
  throw new StrictModeViolation(`Garmin request refused by strict mode firewall: ${reason}`);
}

/** Wrap a fetch with the strict policy. The wrapped fetch is never called for a refused request. */
export function createStrictFetch(base: typeof fetch): typeof fetch {
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const verdict = classifyGarminRequest(input, init);
    switch (verdict.kind) {
      case "not_garmin":
      case "read":
      case "auth":
        return base(input, init);
      case "forbidden":
        return block(input, init, verdict.reason);
      case "write": {
        const scope = scopeStore.getStore();
        if (!scope) return block(input, init, `${verdict.write} write outside a capability scope`);
        if (scope.activityId !== verdict.activityId) {
          return block(input, init, `capability is for activity ${scope.activityId}, not ${verdict.activityId}`);
        }
        if (!scope.allow.has(verdict.write)) return block(input, init, `${verdict.write} not granted by capability`);
        return base(input, init);
      }
    }
  }) as typeof fetch;
  Object.defineProperty(guarded, STRICT_MARK, { value: true });
  return guarded;
}

const STRICT_MARK = Symbol.for("hevy2garmin.strictFetch");

/** True when `globalThis.fetch` (or `target.fetch`) is already the strict wrapper. */
export function isStrictFirewallInstalled(target: { fetch: typeof fetch } = globalThis): boolean {
  return Boolean((target.fetch as unknown as Record<symbol, unknown>)[STRICT_MARK]);
}

/**
 * Replace `target.fetch` with the strict wrapper. Idempotent. Returns a
 * function that restores the previous fetch (tests only; a server never
 * uninstalls it).
 */
export function installStrictGarminFirewall(target: { fetch: typeof fetch } = globalThis): () => void {
  if (isStrictFirewallInstalled(target)) return () => {};
  const previous = target.fetch;
  target.fetch = createStrictFetch(previous.bind(target));
  return () => {
    target.fetch = previous;
  };
}
