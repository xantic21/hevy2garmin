/**
 * Every runtime entry point, in a deployment with NO mode variables (strict):
 * the destructive and alternate paths answer 423 without doing anything, and
 * the sync paths reach the strict engine only, never the legacy engine and
 * never a GitHub Actions dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const legacy = vi.hoisted(() => ({ syncOneWorkout: vi.fn(), listCandidates: vi.fn() }));
const github = vi.hoisted(() => ({ triggerViaActions: vi.fn(), setupGithubActions: vi.fn(), disableGithubActions: vi.fn() }));
const strict = vi.hoisted(() => ({ runStrictSync: vi.fn() }));

vi.mock("@/lib/sync-one", async (orig) => ({ ...(await orig<object>()), syncOneWorkout: legacy.syncOneWorkout }));
vi.mock("@/lib/github", async (orig) => ({ ...(await orig<object>()), ...github, getGithubPat: async () => "ghp_test", getGithubRepo: () => "o/r" }));
vi.mock("@/lib/strict-sync", async (orig) => ({ ...(await orig<object>()), runStrictSync: strict.runStrictSync }));
vi.mock("@/lib/db", () => ({ getDb: () => Object.assign(async () => [], { json: (v: unknown) => v }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const strictResult = (over: Record<string, unknown> = {}) => ({
  status: "dry_run",
  reason: null,
  trigger: "manual",
  dryRun: true,
  hevyId: null,
  title: null,
  activityId: null,
  journalIds: [],
  writes: 0,
  plan: null,
  issues: [],
  ...over,
});

const post = (url: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
const params = (hevyId: string) => ({ params: Promise.resolve({ hevyId }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
  vi.stubEnv("H2G_PASSWORD", "");
  vi.stubEnv("NODE_ENV", "test");
  strict.runStrictSync.mockResolvedValue(strictResult({ status: "none" }));
});

describe("destructive and alternate paths are locked (423) and do nothing", () => {
  const cases: Array<[string, () => Promise<{ POST: (...a: never[]) => Promise<Response> }>, unknown[]]> = [
    ["pending abandon", () => import("./pending/[hevyId]/abandon/route"), [post("http://x/api/pending/1/abandon"), params("1")]],
    ["pending reconcile (finalize)", () => import("./pending/[hevyId]/reconcile/route"), [post("http://x/api/pending/1/reconcile"), params("1")]],
    ["pending retry", () => import("./pending/[hevyId]/retry/route"), [post("http://x/api/pending/1/retry", { confirm: "retry" }), params("1")]],
    ["unsync", () => import("./unsync/[hevyId]/route"), [post("http://x/api/unsync/1"), params("1")]],
    ["unsync all", () => import("./unsync-all/route"), [post("http://x/api/unsync-all", { confirm: "UNSYNC ALL" })]],
    ["mark synced", () => import("./workout/[hevyId]/mark-synced/route"), [post("http://x/api/workout/1/mark-synced", { garmin_activity_id: "5" }), params("1")]],
    ["routine sync", () => import("./routines/[hevyId]/sync/route"), [post("http://x/api/routines/1/sync"), params("1")]],
    ["routine schedule", () => import("./routines/[hevyId]/schedule/route"), [post("http://x/api/routines/1/schedule", { date: "2026-12-01" }), params("1")]],
    ["routine unschedule", () => import("./routines/[hevyId]/unschedule/route"), [post("http://x/api/routines/1/unschedule", { scheduleId: "9" }), params("1")]],
    ["routine remove", () => import("./routines/[hevyId]/remove/route"), [post("http://x/api/routines/1/remove"), params("1")]],
    ["routines bulk sync", () => import("./routines/sync/route"), [post("http://x/api/routines/sync")]],
    ["update fork", () => import("./update-fork/route"), []],
    ["setup GitHub Actions", () => import("./setup-actions/route"), [post("http://x/api/setup-actions")]],
    ["toggle auto-sync", () => import("./toggle-autosync/route"), [post("http://x/api/toggle-autosync", { enabled: true })]],
  ];
  it.each(cases)("%s → 423", async (_name, load, args) => {
    const route = await load();
    const res = await (route.POST as (...a: unknown[]) => Promise<Response>)(...args);
    expect(res.status).toBe(423);
    expect((await res.json()).strict).toBe(true);
    expect(legacy.syncOneWorkout).not.toHaveBeenCalled();
    expect(github.triggerViaActions).not.toHaveBeenCalled();
    expect(github.setupGithubActions).not.toHaveBeenCalled();
    expect(strict.runStrictSync).not.toHaveBeenCalled();
  });
});

describe("sync paths reach the strict engine only", () => {
  it("POST /api/sync-one previews with the strict engine by default", async () => {
    strict.runStrictSync.mockResolvedValueOnce(strictResult({ hevyId: "h1", activityId: 9 }));
    const { POST } = await import("./sync-one/route");
    const res = await POST(post("http://x/api/sync-one"));
    const body = await res.json();
    expect(body).toMatchObject({ status: "dry_run", dryRun: true, wouldUpload: false, strict: { status: "dry_run" } });
    expect(strict.runStrictSync.mock.calls[0][1]).toMatchObject({ dryRun: true, trigger: "manual" });
    expect(legacy.syncOneWorkout).not.toHaveBeenCalled();
  });

  it("POST /api/sync live never dispatches to GitHub, even with a PAT configured", async () => {
    strict.runStrictSync
      .mockResolvedValueOnce(strictResult({ status: "synced", dryRun: false, hevyId: "h1", writes: 2 }))
      .mockResolvedValueOnce(strictResult({ status: "none", dryRun: false }));
    const { POST } = await import("./sync/route");
    const res = await POST(post("http://x/api/sync?live=1"));
    const body = await res.json();
    expect(body).toMatchObject({ mode: "inline", strict: true, totalSynced: 1 });
    expect(github.triggerViaActions).not.toHaveBeenCalled();
    expect(legacy.syncOneWorkout).not.toHaveBeenCalled();
    expect(strict.runStrictSync.mock.calls[0][1]).toMatchObject({ dryRun: false, trigger: "batch" });
    expect(strict.runStrictSync.mock.calls[1][1].excludeHevyIds).toEqual(["h1"]);
  });

  it("POST /api/sync/[id] targets that workout and passes an explicit resync through", async () => {
    strict.runStrictSync.mockResolvedValueOnce(strictResult({ status: "synced", dryRun: false, hevyId: "h7" }));
    const { POST } = await import("./sync/[hevyId]/route");
    await POST(post("http://x/api/sync/h7?live=1&resync=1"), params("h7"));
    expect(strict.runStrictSync.mock.calls[0][1]).toMatchObject({ dryRun: false, targetHevyId: "h7", resync: true });
    expect(legacy.syncOneWorkout).not.toHaveBeenCalled();
  });

  it("a batch stops at the first global stop instead of continuing", async () => {
    strict.runStrictSync.mockResolvedValueOnce(strictResult({ status: "blocked", dryRun: false, reason: "frozen" }));
    const { POST } = await import("./sync/route");
    const body = await (await POST(post("http://x/api/sync?live=1"))).json();
    expect(body.runs).toHaveLength(1);
    expect(strict.runStrictSync).toHaveBeenCalledTimes(1);
  });

  it("the next-candidate route passes over pending workouts instead of looping on them", async () => {
    strict.runStrictSync
      .mockResolvedValueOnce(strictResult({ status: "pending", hevyId: "a" }))
      .mockResolvedValueOnce(strictResult({ status: "needs_review", hevyId: "b" }))
      .mockResolvedValueOnce(strictResult({ status: "dry_run", hevyId: "c", activityId: 3 }));
    const { POST } = await import("./sync-one/route");
    const body = await (await POST(post("http://x/api/sync-one"))).json();
    expect(body.strict.hevyId).toBe("c");
    expect(body.passedOver).toHaveLength(2);
    expect(strict.runStrictSync.mock.calls[2][1].excludeHevyIds).toEqual(["a", "b"]);
  });
});

describe("automatic paths", () => {
  const bearer = { Authorization: "Bearer cron-secret-for-tests" };

  it("cron and webhook need the bearer secret", async () => {
    const cron = await import("./cron/sync/route");
    const res = await cron.GET(new Request("http://x/api/cron/sync", { headers: { Authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(strict.runStrictSync).not.toHaveBeenCalled();
  });

  it("are locked (423) by the strict engine until the owner gate is set, without dispatch or staged retries", async () => {
    strict.runStrictSync.mockResolvedValue(strictResult({ status: "blocked", dryRun: false, reason: "automatic strict sync is off until the owner activates it" }));
    const cron = await import("./cron/sync/route");
    const webhook = await import("./cron/webhook/route");
    expect((await cron.GET(new Request("http://x/api/cron/sync", { headers: bearer }))).status).toBe(423);
    expect((await webhook.POST(post("http://x/api/cron/webhook", { id: "w" }, bearer))).status).toBe(423);
    expect(strict.runStrictSync.mock.calls.map((c) => c[1].trigger)).toEqual(["cron", "webhook"]);
    expect(github.triggerViaActions).not.toHaveBeenCalled();
    expect(legacy.syncOneWorkout).not.toHaveBeenCalled();
  });
});

describe("the proxy refuses locked mutating routes in front of them", () => {
  it.each([
    ["POST", "/api/pending/1/retry", 423],
    ["POST", "/api/unsync-all", 423],
    ["DELETE", "/api/unsync/1", 423],
    ["POST", "/api/routines/sync", 423],
    ["POST", "/api/routines/abc/remove", 423],
    ["POST", "/api/update-fork", 423],
    ["POST", "/api/setup-actions", 423],
    ["POST", "/api/toggle-autosync", 423],
    ["POST", "/api/workout/1/mark-synced", 423],
  ])("%s %s → %i", async (method, path, status) => {
    const { proxy } = await import("../../proxy");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest(`http://localhost${path}`, { method }));
    expect(res.status).toBe(status);
  });

  it("reads and unlocked routes pass the strict check", async () => {
    const { proxy } = await import("../../proxy");
    const { NextRequest } = await import("next/server");
    for (const [method, path] of [["GET", "/api/routines"], ["POST", "/api/sync-one"], ["POST", "/api/workout/1/skip"]] as const) {
      const res = await proxy(new NextRequest(`http://localhost${path}`, { method }));
      expect(res.status).not.toBe(423);
    }
  });
});
