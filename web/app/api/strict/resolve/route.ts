import { str, strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictResolve } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/strict/resolve {journalId, note}: close a reviewed entry. Local only. */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      const journalId = str(body.journalId);
      const note = str(body.note);
      if (!journalId || !note) return { resolved: false, reason: "journalId and a note are required" };
      return { resolved: await strictResolve(sql, journalId, note) };
    },
    { mutating: true },
  );
}
