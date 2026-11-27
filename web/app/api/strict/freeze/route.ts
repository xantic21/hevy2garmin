import { str, strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictSetFrozen, strictStatus } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/strict/freeze {frozen: true, reason} engages the stop switch;
 * {frozen: false, confirm: "UNFREEZE"} lifts it, and only when no journal
 * entry is still open (reconcile or resolve those first).
 */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      if (body.frozen === true) {
        await strictSetFrozen(sql, true, str(body.reason) ?? "stopped by the operator");
        return { frozen: true };
      }
      if (body.frozen === false) {
        if (body.confirm !== "UNFREEZE") return { frozen: true, reason: "confirm must be UNFREEZE" };
        const status = await strictStatus(sql);
        const blocking = status.openJournal.filter((e) => e.phase !== "intent");
        if (blocking.length) return { frozen: true, reason: `${blocking.length} journal entr${blocking.length === 1 ? "y is" : "ies are"} still open` };
        await strictSetFrozen(sql, false, null);
        return { frozen: false };
      }
      return { frozen: null, reason: "frozen must be true or false" };
    },
    { mutating: true },
  );
}
