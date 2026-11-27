import { str, strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictRestore } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workout per request with paced, read-back-verified Garmin calls; within every Vercel plan.
export const maxDuration = 60;

/**
 * POST /api/strict/restore {journalId, source: "pre_write"|"original", confirm: "RESTORE <journalId>"}
 * The operator-approved controlled recovery. The confirmation must name the
 * journal entry, so a replayed or mistyped request cannot restore another one.
 */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      const journalId = str(body.journalId);
      const source = body.source === "original" ? "original" : body.source === "pre_write" ? "pre_write" : null;
      if (!journalId || !source) return { result: { status: "refused", reason: "journalId and source are required" } };
      const confirm = body.confirm === `RESTORE ${journalId}`;
      return { result: await strictRestore(sql, { journalId, source, confirm }) };
    },
    { mutating: true },
  );
}
