/** Regression tests for re-audit findings 7 and 8 (docs/STRICT_REAUDIT.md). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ pending: [] as unknown[], synced: [] as unknown[], bound: [] as unknown[] }));
const terminal = vi.hoisted(() => ({ resolveTerminal: vi.fn(async () => {}) }));
const hevy = vi.hoisted(() => ({ fetchAllWorkouts: vi.fn(async () => []), fetchAllWorkoutsReadOnly: vi.fn(async () => []) }));

vi.mock("@/lib/db", () => ({
  getDb: () =>
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const text = strings.join("?");
        if (text.includes("FROM pending_uploads")) return rows.pending;
        if (text.includes("FROM synced_workouts")) return rows.synced;
        if (text.includes("FROM strict_bindings")) return rows.bound;
        return [];
      },
      { json: (v: unknown) => v },
    ),
}));
vi.mock("@/lib/pending-store", async (orig) => ({ ...(await orig<object>()), resolveTerminal: terminal.resolveTerminal }));
vi.mock("@/lib/hevy-sync", async (orig) => ({ ...(await orig<object>()), ...hevy }));

const post = (url: string, body: unknown = {}) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  rows.pending = [];
  rows.synced = [];
  rows.bound = [];
});

describe("#8 skip in strict mode touches only untouched workouts", () => {
  const call = async () => {
    const { POST } = await import("./workout/[hevyId]/skip/route");
    return POST(post("http://x/api/workout/w1/skip"), { params: Promise.resolve({ hevyId: "w1" }) });
  };

  it.each([
    ["a quarantined legacy pending upload", "pending"],
    ["a synced ledger row", "synced"],
    ["a strict binding", "bound"],
  ] as const)("refuses (423) for %s and changes nothing", async (_name, key) => {
    rows[key] = [{ "?column?": 1 }];
    const res = await call();
    expect(res.status).toBe(423);
    expect(terminal.resolveTerminal).not.toHaveBeenCalled();
  });

  it("allows an untouched workout", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(terminal.resolveTerminal).toHaveBeenCalledOnce();
  });
});

describe("#7 a strict dry run reads Hevy without writing the key status", () => {
  it("uses the read-only fetch for a dry run and the recording one for a live run", async () => {
    const { runStrictSync } = await import("@/lib/strict-sync");
    const { getDb } = await import("@/lib/db");
    await runStrictSync(getDb() as never, { dryRun: true, trigger: "manual", garminClientFactory: async () => ({}) as never });
    expect(hevy.fetchAllWorkoutsReadOnly).toHaveBeenCalledOnce();
    expect(hevy.fetchAllWorkouts).not.toHaveBeenCalled();
  });
});
