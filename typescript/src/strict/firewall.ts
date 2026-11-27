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

/**
 * Process-wide state, shared by EVERY copy of this module.
 *
 * A bundler can load the engine more than once in one process (Next.js
 * compiles instrumentation.ts separately from the app). If each copy had its
 * own AsyncLocalStorage, a capability opened by the app's copy would be
 * invisible to the fetch wrapper installed by instrumentation's copy, and every
 * legitimate strict write would be refused; the counters would disagree too.
 * Keyed with Symbol.for so all copies resolve the same objects.
 */
interface SharedFirewallState {
  scopes: AsyncLocalStorage<GarminWriteScope>;
  blocked: number;
  recent: FirewallEvent[];
  installs: number;
  /**
   * Where a request the policy lets through goes. Null (always, outside the
   * synthetic staging mode): the next fetch in the chain, i.e. the network.
   * In staging: an in-process simulator, so nothing ever leaves the process,
   * while every request still meets this policy first.
   */
  transport?: typeof fetch | null;
}
const SHARED = Symbol.for("hevy2garmin.strictFirewall.state");
const shared: SharedFirewallState = ((globalThis as Record<symbol, unknown>)[SHARED] ??= {
  scopes: new AsyncLocalStorage<GarminWriteScope>(),
  blocked: 0,
  recent: [],
  installs: 0,
}) as SharedFirewallState;
const scopeStore = shared.scopes;

/** Garmin's own hosts: garmin.com, garmin.cn and every subdomain. */
const GARMIN_HOST = /(^|\.)garmin\.(com|cn)$/i;
/**
 * The self-test host: classified as Garmin, but in the RFC 2606 `.invalid`
 * TLD, which never resolves. A firewall that is missing from the chain makes
 * the self-test fail with a DNS error, so no real request can ever leave.
 */
export const FIREWALL_SELFTEST_HOST = "h2g-firewall-selftest.invalid";
const AUTH_HOSTS = /^(sso|diauth)\.garmin\.(com|cn)$/i;
const SETS_PATH = /^\/activity-service\/activity\/(\d+)\/exerciseSets\/?$/;
const ACTIVITY_PATH = /^\/activity-service\/activity\/(\d+)\/?$/;
const METADATA_KEYS = new Set(["activityId", "activityName", "description"]);

function urlOf(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as Request).url));
    // Anything else fetch would stringify (a URL-like object from another realm, a custom class).
    if (input != null) return new URL(String(input));
  } catch {
    return null;
  }
  return null;
}

/** Lower-case, trailing dots removed: `connectapi.garmin.com.` is the same host. */
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.+$/, "");

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
  // Default deny: a target that cannot be inspected cannot be shown to be harmless.
  if (!url) return { kind: "forbidden", reason: "request target is not inspectable" };
  const host = hostOf(url);
  if (!GARMIN_HOST.test(host) && host !== FIREWALL_SELFTEST_HOST) return { kind: "not_garmin" };

  const req = input && typeof input === "object" && "method" in (input as object) ? (input as Request) : null;
  const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
  const overrideRaw = headerOf(init?.headers ?? req?.headers, "X-HTTP-Method-Override");
  const override = overrideRaw == null ? null : overrideRaw.trim().toUpperCase();
  const isRead = (method === "GET" || method === "HEAD") && (override == null || override === "GET" || override === "HEAD");
  // A write is a PUT only when what goes on the wire is PUT, or POST tunnelling
  // PUT. The header never upgrades another real method (DELETE, PATCH, ...).
  const isPut = (method === "PUT" && (override == null || override === "PUT")) || (method === "POST" && override === "PUT");
  const effective = isPut ? "PUT" : (override ?? method);

  if (AUTH_HOSTS.test(host)) return { kind: "auth" };
  if (url.pathname.startsWith("/oauth-service/oauth/") || url.pathname.startsWith("/di-oauth2-service/oauth/")) {
    return { kind: "auth" };
  }
  if (isRead) return { kind: "read" };

  if (isPut) {
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

/** Blocked attempts since process start, for the dashboard's health panel. */
export function firewallStats(): { blocked: number; recent: FirewallEvent[] } {
  return { blocked: shared.blocked, recent: shared.recent.slice() };
}

/**
 * The deployment-level hard stop. Read at call time, so it applies the moment
 * the variable is set, and enforced at the network boundary for every write,
 * a controlled restore included. (The database stop switch is different: it
 * stops syncing but deliberately allows an operator's verified recovery.)
 */
export function strictHardStopActive(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.H2G_STRICT_STOP ?? "").trim());
}

/** True for a StrictModeViolation from ANY copy of this module (instanceof is per copy). */
export function isStrictModeViolation(e: unknown): boolean {
  return e instanceof StrictModeViolation || (e as { code?: unknown } | null)?.code === "STRICT_MODE_VIOLATION";
}

function block(input: unknown, init: RequestInit | undefined, reason: string): never {
  const url = urlOf(input);
  if (!url || hostOf(url) !== FIREWALL_SELFTEST_HOST) {
    shared.blocked += 1;
    shared.recent.unshift({
      at: new Date().toISOString(),
      verdict: "blocked",
      reason,
      method: String(init?.method ?? "GET").toUpperCase(),
      host: url?.hostname ?? "?",
      // The path only: query strings can carry tokens.
      path: url?.pathname ?? "?",
    });
    shared.recent.length = Math.min(shared.recent.length, 20);
  }
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
        return (shared.transport ?? base)(input, init);
      case "forbidden":
        return block(input, init, verdict.reason);
      case "write": {
        // The deployment-level hard stop beats every capability, restore included.
        if (strictHardStopActive()) return block(input, init, "H2G_STRICT_STOP is set: every Garmin write is refused");
        const scope = scopeStore.getStore();
        if (!scope) return block(input, init, `${verdict.write} write outside a capability scope`);
        if (scope.activityId !== verdict.activityId) {
          return block(input, init, `capability is for activity ${scope.activityId}, not ${verdict.activityId}`);
        }
        if (!scope.allow.has(verdict.write)) return block(input, init, `${verdict.write} not granted by capability`);
        return (shared.transport ?? base)(input, init);
      }
    }
  }) as typeof fetch;
  Object.defineProperty(guarded, STRICT_MARK, { value: true });
  return guarded;
}

const STRICT_MARK = Symbol.for("hevy2garmin.strictFetch");

/**
 * Route every request the policy allows to `transport` instead of the network
 * (null restores the network). Only the synthetic staging mode sets it, to an
 * in-process simulator; refused requests never reach it. Returns the previous
 * transport.
 */
export function setStrictTransport(transport: typeof fetch | null): typeof fetch | null {
  const previous = shared.transport ?? null;
  shared.transport = transport;
  return previous;
}

export function strictTransportActive(): boolean {
  return Boolean(shared.transport);
}

/** True when `globalThis.fetch` (or `target.fetch`) is already the strict wrapper. */
export function isStrictFirewallInstalled(target: { fetch: typeof fetch } = globalThis): boolean {
  return Boolean((target.fetch as unknown as Record<symbol, unknown>)[STRICT_MARK]);
}

/**
 * Make the strict wrapper the OUTERMOST fetch. Idempotent when it already is.
 * When something wrapped it since (Next.js patches the global fetch for its
 * cache), it wraps again on top: the policy is idempotent, so a request still
 * meets it exactly once before the network. Returns a function that restores
 * the previous fetch (tests only; a server never uninstalls it).
 */
export function installStrictGarminFirewall(target: { fetch: typeof fetch } = globalThis): () => void {
  if (isStrictFirewallInstalled(target)) return () => {};
  const previous = target.fetch;
  target.fetch = createStrictFetch(previous.bind(target));
  shared.installs += 1;
  return () => {
    target.fetch = previous;
  };
}

/**
 * Prove, without any network access, that `target.fetch` refuses a FIT upload.
 * It sends a request to the never-resolving self-test host: refused by the
 * firewall → enforced; anything else (a DNS failure, a response) → not.
 */
export async function firewallSelfTest(target: { fetch: typeof fetch } = globalThis): Promise<boolean> {
  try {
    await target.fetch(`https://${FIREWALL_SELFTEST_HOST}/upload-service/upload/.fit`, { method: "POST", body: "selftest" });
    return false;
  } catch (e) {
    return isStrictModeViolation(e);
  }
}
