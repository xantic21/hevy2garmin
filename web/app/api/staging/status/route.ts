import { NextResponse } from "next/server";
import { STAGING_SCENARIOS } from "@/lib/staging-fixtures";
import { STAGING_MARKER_KEY, stagingMode } from "@/lib/staging-mode";
import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictTransportActive } from "hevy2garmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/staging/status: the staging marker, the simulated Garmin state per
 * activity (set count, whether exercise names are present, name/description),
 * and the last simulated requests. Read-only; synthetic staging only.
 */
export async function GET(request: Request) {
  if (!stagingMode()) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  return strictOperatorRoute(
    request,
    async (sql) => {
      const marker = (await sql`SELECT value FROM app_cache WHERE key = ${STAGING_MARKER_KEY}`) as Array<{ value: unknown }>;
      const activities = (await sql`
        SELECT activity_id, quirk, detail->>'activityName' AS name, detail->>'description' AS description,
               jsonb_array_length(sets) AS sets,
               (SELECT count(*) FROM jsonb_array_elements(sets) s, jsonb_array_elements(s->'exercises') e WHERE e->>'name' IS NOT NULL)::int AS named
        FROM staging_garmin_activities ORDER BY activity_id`) as unknown[];
      const requests = (await sql`SELECT at, method, host, path, status, note FROM staging_requests ORDER BY id DESC LIMIT 40`) as unknown[];
      const refused = (await sql`SELECT count(*)::int AS n FROM staging_requests WHERE note = 'refused'`) as Array<{ n: number }>;
      // Over EVERY logged request, not only the recent ones shown below.
      const hosts = ((await sql`SELECT DISTINCT host FROM staging_requests ORDER BY host`) as Array<{ host: string }>).map((r) => r.host);
      const writes = (await sql`SELECT method, path, count(*)::int AS n FROM staging_requests WHERE method <> 'GET' GROUP BY method, path ORDER BY path`) as Array<{ method: string; path: string; n: number }>;
      const total = (await sql`SELECT count(*)::int AS n FROM staging_requests`) as Array<{ n: number }>;
      return {
        staging: {
          marker: marker[0]?.value ?? null,
          transport: strictTransportActive(),
          scenarios: STAGING_SCENARIOS.map((s) => ({ hevyId: s.hevyId, title: s.title, activities: s.activities.map((a) => a.id), expect: s.expect })),
          activities,
          refusedRequests: refused[0]?.n ?? 0,
          totalRequests: total[0]?.n ?? 0,
          hosts,
          writes,
          requests,
        },
      };
    },
    { mutating: false },
  );
}
