import { str, strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictReconcile } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/strict/reconcile {journalId}: read-back only, never writes to Garmin. */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      const journalId = str(body.journalId);
      if (!journalId) return { result: { status: "refused", reason: "journalId is required" } };
      return { result: await strictReconcile(sql, journalId) };
    },
    { mutating: true },
  );
}
