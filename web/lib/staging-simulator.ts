/**
 * The synthetic-staging network: Hevy and Garmin Connect simulated at the HTTP
 * level, state in the staging tables (lib/staging-guard.ts), every request
 * logged in `staging_requests`.
 *
 * It is installed as the strict firewall's TRANSPORT (setStrictTransport), so
 * every request first meets the production firewall unchanged (uploads,
 * deletes, writes outside a capability scope, the hard stop: all refused
 * before they get here) and what the firewall lets through is answered here
 * instead of by the network. Any host other than the two simulated APIs and
 * this deployment's own origin is refused: nothing leaves the process.
 *
 * Simulated Garmin behaviours per activity (`quirk`), to rehearse recovery:
 *   drop_names    the sets PUT is stored with every exercise name removed
 *                 (read-back mismatch → needs review → restore)
 *   lose_response the sets PUT is stored but answered 502; the immediate
 *                 read-back finds it applied → verified (no blind retry)
 *   blackout      as lose_response, and reads of the activity fail for 60 s
 *                 afterwards (uncertain → writes blocked → reconcile by
 *                 read-back once Garmin answers again → verified)
 *   reject        the sets PUT is refused with 400 and nothing is stored
 */
import { GarminClient } from "garmin-auth";
import { setStrictTransport } from "hevy2garmin";
import { getDb } from "./db";
import { stagingMode } from "./staging-mode";

type Sql = ReturnType<typeof getDb>;

export const STAGING_HEVY_KEY = "h2g-staging-synthetic-key";
const STAGING_TOKENS = JSON.stringify({ di_token: "h2g-staging-synthetic", di_refresh_token: "h2g-staging-synthetic", di_client_id: "h2g-staging" });

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const asNumber = (v: string | null, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

function requestParts(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const effective = (headers.get("X-HTTP-Method-Override") ?? method).toUpperCase();
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  return { url, effective, host, body: typeof init?.body === "string" ? init.body : null };
}

/** This deployment's own origin (the proxy reads the session epoch from it). */
function ownHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  return [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].some((h) => h && h.toLowerCase() === host);
}

async function hevy(sql: Sql, method: string, url: URL): Promise<Response> {
  if (method !== "GET") return json({ error: "staging: the Hevy simulator is read-only" }, 405);
  const path = url.pathname.replace(/\/+$/, "");
  const all = async () =>
    ((await sql`SELECT payload FROM staging_hevy_workouts ORDER BY start_time DESC`) as Array<{ payload: Record<string, unknown> }>).map((r) => r.payload);
  if (path === "/v1/workouts/count") return json({ workout_count: (await all()).length });
  if (path === "/v1/workouts" || path === "/v1/workouts/events") {
    const page = asNumber(url.searchParams.get("page"), 1);
    const size = asNumber(url.searchParams.get("pageSize"), 10);
    let items = await all();
    const since = url.searchParams.get("since");
    if (path.endsWith("/events") && since) items = items.filter((w) => String(w.updated_at ?? "") > since);
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    const slice = items.slice((page - 1) * size, page * size);
    return path.endsWith("/events")
      ? json({ page, page_count: pageCount, events: slice.map((workout) => ({ type: "updated", workout })) })
      : json({ page, page_count: pageCount, workouts: slice });
  }
  const one = path.match(/^\/v1\/workouts\/([^/]+)$/);
  if (one) {
    const rows = (await sql`SELECT payload FROM staging_hevy_workouts WHERE id = ${one[1]}`) as Array<{ payload: unknown }>;
    return rows.length ? json(rows[0].payload) : json({ error: "not found" }, 404);
  }
  if (path === "/v1/routines") return json({ page: 1, page_count: 1, routines: [] });
  if (path === "/v1/routine_folders") return json({ page: 1, page_count: 1, routine_folders: [] });
  if (path === "/v1/exercise_templates") return json({ page: 1, page_count: 1, exercise_templates: [] });
  return json({ error: "not simulated" }, 404);
}

async function garmin(sql: Sql, method: string, url: URL, body: string | null): Promise<{ res: Response; note?: string }> {
  const path = url.pathname.replace(/\/+$/, "");
  if (method === "GET" && path === "/activitylist-service/activities/search/activities") {
    const start = url.searchParams.get("startDate") ?? "1970-01-01";
    const end = url.searchParams.get("endDate") ?? "2999-12-31";
    const limit = asNumber(url.searchParams.get("limit"), 20);
    const rows = (await sql`
      SELECT a.summary, a.detail FROM staging_garmin_activities a
      WHERE a.start_gmt >= ${`${start}T00:00:00Z`}::timestamptz AND a.start_gmt < (${`${end}T00:00:00Z`}::timestamptz + interval '1 day')
      ORDER BY a.start_gmt DESC LIMIT ${limit}`) as Array<{ summary: Record<string, unknown>; detail: Record<string, unknown> }>;
    return { res: json(rows.map((r) => ({ ...r.summary, activityName: r.detail.activityName }))) };
  }
  const sets = path.match(/^\/activity-service\/activity\/(\d+)\/exerciseSets$/);
  const activity = path.match(/^\/activity-service\/activity\/(\d+)$/);
  const id = Number((sets ?? activity)?.[1]);
  if (sets || activity) {
    const rows = (await sql`SELECT detail, sets, quirk, (reads_fail_until > NOW()) AS blacked_out FROM staging_garmin_activities WHERE activity_id = ${id}`) as Array<{
      detail: Record<string, unknown>;
      sets: unknown[];
      quirk: string | null;
      blacked_out: boolean | null;
    }>;
    if (!rows.length) return { res: json({ error: "not found" }, 404) };
    const row = rows[0];
    if (method === "GET") {
      if (row.blacked_out) return { res: json({ error: "simulated outage" }, 503), note: "quirk blackout (read failed)" };
      return { res: json(sets ? { activityId: id, exerciseSets: row.sets } : row.detail) };
    }
    if (method !== "PUT" || !body) return { res: json({ error: "staging: not simulated" }, 405), note: "refused" };
    const sent = JSON.parse(body) as Record<string, unknown>;
    if (sets) {
      if (row.quirk === "reject") return { res: json({ error: "simulated rejection" }, 400), note: "quirk reject" };
      let stored = (sent.exerciseSets as Array<Record<string, unknown>>) ?? [];
      if (row.quirk === "drop_names") {
        stored = stored.map((x) => ({ ...x, exercises: ((x.exercises as Array<Record<string, unknown>>) ?? []).map((e) => ({ ...e, name: null })) }));
      }
      await sql`UPDATE staging_garmin_activities SET sets = ${sql.json(stored)} WHERE activity_id = ${id}`;
      if (row.quirk === "lose_response") return { res: json({ error: "simulated lost response" }, 502), note: "quirk lose_response (stored)" };
      if (row.quirk === "blackout") {
        await sql`UPDATE staging_garmin_activities SET reads_fail_until = NOW() + interval '60 seconds' WHERE activity_id = ${id}`;
        return { res: json({ error: "simulated lost response" }, 502), note: "quirk blackout (stored, reads fail 60 s)" };
      }
      return { res: new Response(null, { status: 204 }), note: row.quirk ? `quirk ${row.quirk}` : undefined };
    }
    const detail = { ...row.detail };
    if (sent.activityName !== undefined) detail.activityName = sent.activityName;
    if (sent.description !== undefined) detail.description = sent.description;
    await sql`UPDATE staging_garmin_activities SET detail = ${sql.json(detail)} WHERE activity_id = ${id}`;
    return { res: new Response(null, { status: 204 }) };
  }
  if (method !== "GET") return { res: json({ error: "staging: not simulated" }, 405), note: "refused" };
  if (path === "/userprofile-service/socialProfile") return { res: json({ displayName: "synthetic-athlete", fullName: "Synthetic Athlete" }) };
  if (path.startsWith("/wellness-service/wellness/dailyHeartRate")) return { res: json({ heartRateValues: [] }) };
  return { res: json({ error: "not simulated" }, 404) };
}

/** The transport: the simulated APIs, this deployment's own origin, nothing else. */
export function createStagingTransport(getSql: () => Sql = getDb, network: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { url, effective, host, body } = requestParts(input, init);
    // This deployment's own origin, for the one request the proxy makes there (the session epoch), and nothing else.
    if (ownHost(host) && effective === "GET" && /\/api\/session-epoch\/?$/.test(url.pathname)) return network(input, init);
    let res: Response;
    let note: string | undefined;
    const sql = getSql();
    try {
      if (host === "api.hevyapp.com") res = await hevy(sql, effective, url);
      else if (host === "connectapi.garmin.com") ({ res, note } = await garmin(sql, effective, url, body));
      else if (/(^|\.)garmin\.(com|cn)$/.test(host)) {
        res = json({ error: "staging: no Garmin sign-in or token refresh" }, 403);
        note = "refused";
      } else {
        res = json({ error: `staging: external network disabled (${host})` }, 503);
        note = "refused";
      }
    } catch (e) {
      res = json({ error: `staging simulator: ${(e as Error).message}` }, 500);
    }
    // The path only: query strings never carry anything here, but the log is shown in the dashboard.
    await sql`INSERT INTO staging_requests (method, host, path, status, note) VALUES (${effective}, ${host}, ${url.pathname}, ${res.status}, ${note ?? null})`.catch(() => {});
    return res;
  }) as typeof fetch;
}

const INSTALLED = Symbol.for("hevy2garmin.staging.transport");

/** Route the firewall's allowed traffic to the simulator. No-op outside staging. Idempotent. */
export function installStagingTransport(): boolean {
  if (!stagingMode()) return false;
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return false;
  // The network fetch as it is now (before the firewall wraps it), for this deployment's own origin only.
  const network = globalThis.fetch.bind(globalThis);
  setStrictTransport(createStagingTransport(getDb, network));
  g[INSTALLED] = true;
  return true;
}

/** A Garmin client with synthetic tokens; it only ever reaches the simulator. */
export function stagingGarminClient(): GarminClient {
  const c = new GarminClient();
  c.loads(STAGING_TOKENS);
  return c;
}
