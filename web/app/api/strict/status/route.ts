import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictStatus } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/strict/status: mode, firewall, schema, stop switch, open journal, bindings. Read-only. */
export async function GET(request: Request) {
  return strictOperatorRoute(request, async (sql) => ({ status: await strictStatus(sql) }), { mutating: false });
}
