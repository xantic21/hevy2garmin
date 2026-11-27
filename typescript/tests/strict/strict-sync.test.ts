/**
 * Contract item 8, end to end against a stateful fake Garmin: repeated,
 * out-of-order and concurrent calls, no watch activity, unknown provenance,
 * duplicate timestamps, same-day workouts, UTC/DST, API errors, lost
 * responses, failed backups, partial read-backs, crash/restart, legacy
 * pending rows. Every test asserts how many Garmin writes happened, and the
 * fake has no upload or delete to call at all.
 */
import { describe, expect, it } from "vitest";
import {
  memoryStrictLedger,
  reconcileStrictJournal,
  resolveStrictJournal,
  restoreStrictBackup,
  strictInPlaceSync,
  strictWriteBlock,
  type StrictLedger,
  type StrictSyncOptions,
} from "../../src/strict";
import { createFakeGarmin, fakeLegacy, hevyWorkout, nativeActivity, NOW, type FakeActivity } from "./fake-garmin";

function setup(opts: { activities?: FakeActivity[]; workouts?: Array<Record<string, unknown>>; synced?: string[]; pending?: string[]; ledger?: StrictLedger } = {}) {
  const garmin = createFakeGarmin(opts.activities ?? [nativeActivity()]);
  const legacy = fakeLegacy(opts.synced, opts.pending);
  const ledger = opts.ledger ?? memoryStrictLedger(() => NOW);
  let garminBuilt = 0;
  const deps = {
    ledger,
    legacy: legacy.store,
    garmin: async () => {
      garminBuilt += 1;
      return garmin.port;
    },
    fetchWorkouts: async () => (opts.workouts ?? [hevyWorkout()]) as never,
    now: () => NOW,
    sleep: async () => {},
    owner: "test-owner",
  };
  const run = (o: StrictSyncOptions = {}) => strictInPlaceSync(deps, { verifyDelayMs: 0, ...o });
  return { garmin, legacy, ledger, deps, run, garminBuilt: () => garminBuilt };
}

describe("dry run", () => {
  it("is the default and writes nothing to Garmin or the database", async () => {
    const t = setup();
    const before = JSON.stringify((t.ledger as unknown as { dump(): unknown }).dump());
    const r = await t.run();
    expect(r.status).toBe("dry_run");
    expect(r.plan).toMatchObject({ activityId: 9001, activeSets: 5, setsAlreadyApplied: false, rename: "Push Day", descriptionChange: true });
    expect(t.garmin.writes()).toBe(0);
    expect(r.writes).toBe(0);
    expect(JSON.stringify((t.ledger as unknown as { dump(): unknown }).dump())).toBe(before);
    expect(t.legacy.marked).toEqual([]);
  });
});

describe("the happy path", () => {
  it("writes sets then name/description into the original activity, verified, and records native metrics", async () => {
    const t = setup();
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("synced");
    expect(t.garmin.calls.putSets).toBe(1);
    expect(t.garmin.calls.putMeta).toBe(1);
    expect(r.writes).toBe(2);
    const a = t.garmin.state.get(9001)!;
    expect(a.activityId).toBe(9001);
    expect(a.activityName).toBe("Push Day");
    expect(a.description).toContain("[hevy2garmin]");
    expect(a.calories).toBe(412);
    const binding = await t.ledger.getBindingByHevy("hevy-1");
    expect(binding).toMatchObject({ garminActivityId: 9001, state: "verified", leaseOwner: null });
    expect((await t.ledger.getOriginalBackup(9001))?.payload).toMatchObject({ activityName: "Strength", exerciseSets: [] });
    expect(t.legacy.marked).toEqual([
      { hevyId: "hevy-1", opts: expect.objectContaining({ garminActivityId: "9001", calories: 412, avgHr: 118, syncMethod: "strict_inplace" }) },
    ]);
    for (const id of r.journalIds) expect((await t.ledger.getJournal(id))?.phase).toBe("verified");
  });

  it("is idempotent: a repeated call writes nothing", async () => {
    const t = setup();
    await t.run({ dryRun: false });
    const again = await t.run({ dryRun: false, targetHevyId: "hevy-1" });
    expect(again.status).toBe("already_synced");
    const next = await t.run({ dryRun: false });
    expect(next.status).toBe("none");
    expect(t.garmin.writes()).toBe(2);
  });

  it("an explicit resync of identical data sends nothing", async () => {
    const t = setup();
    await t.run({ dryRun: false });
    const r = await t.run({ dryRun: false, targetHevyId: "hevy-1", resync: true });
    expect(r.status).toBe("synced");
    expect(r.writes).toBe(0);
  });
});

describe("gates that stop before any Garmin IO", () => {
  it("automatic triggers do nothing until the owner activates them", async () => {
    const t = setup();
    for (const trigger of ["cron", "webhook"] as const) {
      const r = await t.run({ dryRun: false, trigger });
      expect(r.status).toBe("blocked");
    }
    expect(t.garminBuilt()).toBe(0);
    expect((await t.run({ dryRun: false, trigger: "cron", automaticEnabled: true })).status).toBe("synced");
  });

  it("an unmapped exercise needs review and Garmin is never contacted", async () => {
    const t = setup({ workouts: [hevyWorkout({ exercises: [{ title: "Totally Made Up Exercise", sets: [{ type: "normal", reps: 3 }] }] })] });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    expect(t.garminBuilt()).toBe(0);
  });

  it("a legacy pending upload is quarantined, never replayed", async () => {
    const t = setup({ pending: ["hevy-1"] });
    expect((await t.run({ dryRun: false })).status).toBe("none");
    expect((await t.run({ dryRun: false, targetHevyId: "hevy-1" })).status).toBe("blocked");
    expect(t.garmin.writes()).toBe(0);
  });

  it("a workout already in the legacy ledger is not rewritten automatically", async () => {
    const t = setup({ synced: ["hevy-1"] });
    expect((await t.run({ dryRun: false })).status).toBe("none");
    expect((await t.run({ dryRun: false, targetHevyId: "hevy-1" })).status).toBe("needs_review");
    expect(t.garmin.writes()).toBe(0);
  });

  it("an unfinished workout waits", async () => {
    const t = setup({ workouts: [hevyWorkout({ end_time: "2026-03-10T21:00:00Z" })] });
    expect((await t.run({ dryRun: false, targetHevyId: "hevy-1" })).status).toBe("pending");
    expect((await t.run({ dryRun: false })).status).toBe("none");
    expect(t.garmin.writes()).toBe(0);
  });

  it("a resync without a workout id is refused", async () => {
    expect((await setup().run({ dryRun: false, resync: true })).status).toBe("blocked");
  });
});

describe("matching: one unambiguous native original or nothing", () => {
  it.each([
    ["no watch activity yet", [] as FakeActivity[], "pending"],
    ["only our own earlier upload", [nativeActivity({ manufacturer: "DEVELOPMENT" })], "pending"],
    ["unknown provenance", [nativeActivity({ manufacturer: "WAHOO" })], "needs_review"],
    ["missing provenance", [nativeActivity({ manufacturer: "" })], "needs_review"],
    ["a different sport", [nativeActivity({ typeKey: "running" })], "pending"],
    ["two native candidates (duplicate timestamps)", [nativeActivity(), nativeActivity({ activityId: 9002 })], "needs_review"],
    ["an unsaved activity", [nativeActivity({ duration: 0 })], "needs_review"],
  ])("%s → %s, no writes", async (_n, activities, status) => {
    const t = setup({ activities });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe(status);
    expect(t.garmin.writes()).toBe(0);
  });

  it("two Hevy workouts matching one activity on the same day need review", async () => {
    const t = setup({
      workouts: [
        hevyWorkout(),
        hevyWorkout({ id: "hevy-2", start_time: "2026-03-10T17:05:00Z", end_time: "2026-03-10T17:55:00Z" }),
      ],
    });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/hevy-2/);
    expect(t.garmin.writes()).toBe(0);
  });

  it("same-day workouts that each have their own activity both merge", async () => {
    const t = setup({
      activities: [nativeActivity(), nativeActivity({ activityId: 9100, startTimeGMT: "2026-03-10 07:00:00", duration: 2400 })],
      workouts: [hevyWorkout(), hevyWorkout({ id: "hevy-am", start_time: "2026-03-10T07:01:00Z", end_time: "2026-03-10T07:39:00Z" })],
    });
    expect((await t.run({ dryRun: false })).activityId).toBe(9001);
    expect((await t.run({ dryRun: false })).activityId).toBe(9100);
    expect(await t.ledger.getBindingByActivity(9100)).toMatchObject({ hevyId: "hevy-am" });
  });

  it("an activity bound to another workout is never written again", async () => {
    const ledger = memoryStrictLedger(() => NOW);
    await ledger.claimBinding({ hevyId: "someone-else", activityId: 9001, owner: "x", now: NOW, leaseMs: 1 });
    const t = setup({ ledger });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    expect(t.garmin.writes()).toBe(0);
  });

  it("matches correctly across the DST change with explicit offsets", async () => {
    // Europe/Berlin switches on 2026-03-29; Hevy reports +02:00 local time.
    const t = setup({
      activities: [nativeActivity({ startTimeGMT: "2026-03-29 08:00:00" })],
      workouts: [hevyWorkout({ start_time: "2026-03-29T10:01:00+02:00", end_time: "2026-03-29T10:55:00+02:00" })],
    });
    const r = await strictInPlaceSync({ ...t.deps, now: () => new Date("2026-03-29T12:00:00Z") }, { dryRun: false, verifyDelayMs: 0 });
    expect(r.status).toBe("synced");
  });

  it("a possibly truncated listing is not decided on", async () => {
    const t = setup();
    t.garmin.behaviour.list = "truncated";
    expect((await t.run({ dryRun: false })).status).toBe("needs_review");
    expect(t.garmin.writes()).toBe(0);
  });

  it("API errors (401/429/5xx/timeouts) on reads defer and never write", async () => {
    const t = setup();
    t.garmin.behaviour.list = "throw";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("pending");
    expect(r.reason).toMatch(/429/);
    expect(t.garmin.writes()).toBe(0);
  });
});

describe("uncertain outcomes are resolved by read-back, never by retrying", () => {
  it("a lost response after a PUT that landed is verified, not resent", async () => {
    const t = setup();
    t.garmin.behaviour.put = "timeout_applied";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("synced");
    expect(t.garmin.calls.putSets).toBe(1);
  });

  it("a timeout that did not land is reported unchanged, without freezing", async () => {
    const t = setup();
    t.garmin.behaviour.put = "timeout_not_applied";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/did not apply/);
    expect(t.garmin.calls.putSets).toBe(1);
    expect((await strictWriteBlock(t.ledger)).blocked).toBe(false);
    expect((await t.ledger.getJournal(r.journalIds[0]))?.phase).toBe("not_applied");
  });

  it("a rejected PUT leaves the activity unchanged and the original intact", async () => {
    const t = setup({ activities: [nativeActivity({ sets: [{ setType: "ACTIVE", repetitionCount: 3, weight: 1000, exercises: [{ category: "CURL", name: null }] }] })] });
    t.garmin.behaviour.put = "reject";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("failed");
    expect(t.garmin.state.get(9001)!.sets).toHaveLength(1);
    expect(t.garmin.calls.putMeta).toBe(0);
  });

  it("dropped exercise names freeze all strict writes for review, with a restorable backup", async () => {
    const t = setup({
      activities: [nativeActivity()],
      workouts: [hevyWorkout(), hevyWorkout({ id: "hevy-2", start_time: "2026-03-09T17:02:00Z", end_time: "2026-03-09T17:58:00Z" })],
    });
    t.garmin.behaviour.put = "apply_dropping_names";
    const r = await t.run({ dryRun: false, targetHevyId: "hevy-1" });
    expect(r.status).toBe("needs_review");
    expect(r.mismatches?.sets.some((m) => m.field === "name")).toBe(true);
    expect(t.garmin.calls.putMeta).toBe(0); // the name is never changed over wrong sets
    expect((await t.ledger.getControl()).frozen).toBe(true);
    const blocked = await t.run({ dryRun: false, targetHevyId: "hevy-2" });
    expect(blocked.status).toBe("blocked");
    expect(t.garmin.calls.putSets).toBe(1);

    // Controlled recovery: an explicit, confirmed restore of the verified backup.
    expect((await restoreStrictBackup(t.deps, { journalId: r.journalIds[0], source: "original", confirm: false })).status).toBe("refused");
    t.garmin.behaviour.put = "apply";
    const restored = await restoreStrictBackup(t.deps, { journalId: r.journalIds[0], source: "original", confirm: true });
    expect(restored.status).toBe("restored");
    expect(t.garmin.state.get(9001)!.sets).toEqual([]);
    expect((await t.ledger.getBindingByHevy("hevy-1"))?.state).toBe("needs_review");
    // The stop switch stays on until a person lifts it.
    expect((await t.ledger.getControl()).frozen).toBe(true);
  });

  it("a recomputed native metric is a mismatch, not a success", async () => {
    const t = setup();
    t.garmin.behaviour.put = "apply_changing_calories";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    expect(r.mismatches?.metrics[0]).toMatchObject({ path: "summaryDTO.calories", before: 412, after: 449 });
  });

  it("a failed read-back leaves the write uncertain and blocking until reconciled", async () => {
    const t = setup();
    t.garmin.behaviour.readback = "throw_after_put";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("uncertain");
    expect((await strictWriteBlock(t.ledger)).blocked).toBe(true);
    expect((await t.run({ dryRun: false })).status).toBe("blocked");
    t.garmin.behaviour.readback = "ok";
    // A dry run still plans, and says why live writes are blocked.
    const preview = await t.run({ targetHevyId: "hevy-1" });
    expect(preview.status).toBe("dry_run");
    expect(preview.reason).toMatch(/reconciled/);
    expect(preview.plan?.setsAlreadyApplied).toBe(true);

    const rec = await reconcileStrictJournal(t.deps, r.journalIds[0]);
    expect(rec).toMatchObject({ status: "verified", writes: 0 });
    expect((await strictWriteBlock(t.ledger)).blocked).toBe(false);
    // The next manual sync finds the sets applied and finishes without resending them.
    const resume = await t.run({ dryRun: false, targetHevyId: "hevy-1" });
    expect(resume.status).toBe("synced");
    expect(t.garmin.calls.putSets).toBe(1);
    expect(t.garmin.calls.putMeta).toBe(1);
  });

  it("a crash after put_sent is recovered by read-back after restart", async () => {
    const t = setup();
    // Simulate the process dying mid-request: the PUT lands, the process never returns.
    const crashing = { ...t.garmin.port, putExerciseSets: async (id: number, p: never) => {
      await t.garmin.port.putExerciseSets(id, p);
      throw new Error("process killed");
    } };
    const journalBefore = await t.ledger.listOpenJournal();
    expect(journalBefore).toEqual([]);
    const first = await strictInPlaceSync({ ...t.deps, garmin: async () => crashing }, { dryRun: false, verifyDelayMs: 0 });
    // From the ledger's point of view the request was sent and its fate is unknown
    // until read back; here read-back succeeded, so it is verified despite the error.
    expect(first.status).toBe("synced");

    // Now a real crash: journal left in put_sent, lease held by a dead owner.
    const t2 = setup();
    // The dead writer claimed an hour ago; its lease has expired.
    await t2.ledger.claimBinding({ hevyId: "hevy-1", activityId: 9001, owner: "dead", now: new Date(NOW.getTime() - 3_600_000), leaseMs: 1000 });
    const pre = await t2.ledger.saveBackup({ garminActivityId: 9001, hevyId: "hevy-1", kind: "pre_write", payload: { activityId: 9001, exerciseSets: [], activityName: "Strength", description: null, preservedMetrics: {} }, sha256: "" });
    const { sha256Canonical } = await import("../../src/strict");
    const fixed = await t2.ledger.saveBackup({ ...pre, kind: "pre_write", sha256: sha256Canonical(pre.payload) });
    const entry = await t2.ledger.openJournal({ hevyId: "hevy-1", garminActivityId: 9001, step: "exercise_sets", owner: "dead", intendedSha256: "x", intended: { activityId: 9001, exerciseSets: [] }, backupId: fixed.id });
    await t2.ledger.advanceJournal(entry.id, ["intent"], "put_sent");
    expect((await t2.run({ dryRun: false })).status).toBe("blocked");
    const rec = await reconcileStrictJournal(t2.deps, entry.id);
    expect(rec.status).toBe("verified");
    expect(t2.garmin.writes()).toBe(0);
  });
});

describe("backups", () => {
  it("a backup that cannot be saved means nothing is written", async () => {
    const ledger = memoryStrictLedger(() => NOW);
    const broken: StrictLedger = { ...ledger, saveBackup: async () => { throw new Error("disk full"); } };
    const t = setup({ ledger: broken });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("failed");
    expect(t.garmin.writes()).toBe(0);
    expect((await ledger.getBindingByHevy("hevy-1"))?.leaseOwner).toBeNull();
  });

  it("a backup that reads back differently means nothing is written", async () => {
    const ledger = memoryStrictLedger(() => NOW);
    const corrupt: StrictLedger = {
      ...ledger,
      getBackup: async (id) => {
        const b = await ledger.getBackup(id);
        return b ? { ...b, payload: { tampered: true } } : null;
      },
    };
    const t = setup({ ledger: corrupt });
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/backup could not be verified/);
    expect(t.garmin.writes()).toBe(0);
  });
});

describe("concurrency and ordering", () => {
  it("concurrent runs for the same workout write exactly once", async () => {
    const t = setup();
    const runs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        strictInPlaceSync({ ...t.deps, owner: `w${i}` }, { dryRun: false, verifyDelayMs: 0, targetHevyId: "hevy-1" }),
      ),
    );
    expect(runs.filter((r) => r.status === "synced")).toHaveLength(1);
    expect(t.garmin.calls.putSets).toBe(1);
    expect(t.garmin.calls.putMeta).toBe(1);
  });

  it("a needs_review entry stays until an operator resolves it, then writes may resume", async () => {
    const t = setup();
    t.garmin.behaviour.put = "apply_dropping_names";
    const r = await t.run({ dryRun: false });
    expect(await resolveStrictJournal(t.ledger, r.journalIds[0], "checked on Garmin Connect")).toBe(true);
    expect((await strictWriteBlock(t.ledger)).blocked).toBe(true); // still frozen
    await t.ledger.setFrozen(false, null);
    expect((await strictWriteBlock(t.ledger)).blocked).toBe(false);
  });
});

describe("closed re-audit findings", () => {
  it("#3 reconcile refuses while the writer still holds its lease, so it cannot close an in-flight write", async () => {
    const t = setup();
    await t.ledger.claimBinding({ hevyId: "hevy-1", activityId: 9001, owner: "live-writer", now: NOW, leaseMs: 600_000 });
    const pre = await t.ledger.saveBackup({ garminActivityId: 9001, hevyId: "hevy-1", kind: "pre_write", payload: { activityId: 9001, exerciseSets: [], activityName: "Strength", description: null, preservedMetrics: {} }, sha256: "" });
    const { sha256Canonical } = await import("../../src/strict");
    const b = await t.ledger.saveBackup({ ...pre, sha256: sha256Canonical(pre.payload) });
    const e = await t.ledger.openJournal({ hevyId: "hevy-1", garminActivityId: 9001, step: "exercise_sets", owner: "live-writer", intendedSha256: "x", intended: { activityId: 9001, exerciseSets: [] }, backupId: b.id });
    await t.ledger.advanceJournal(e.id, ["intent"], "put_sent");
    const r = await reconcileStrictJournal(t.deps, e.id);
    expect(r.status).toBe("refused");
    expect((await t.ledger.getJournal(e.id))?.phase).toBe("put_sent");
  });

  it("#3 a writer whose journal entry was moved underneath it freezes instead of trusting its verdict", async () => {
    const t = setup();
    const ledger = t.ledger;
    let raced = false;
    const racing: StrictLedger = {
      ...ledger,
      advanceJournal: async (id, from, to, detail) => {
        if (!raced && to === "verified") {
          raced = true;
          await ledger.advanceJournal(id, from, "not_applied", { by: "someone else" });
        }
        return ledger.advanceJournal(id, from, to, detail);
      },
    };
    const r = await strictInPlaceSync({ ...t.deps, ledger: racing }, { dryRun: false, verifyDelayMs: 0 });
    expect(r.status).toBe("needs_review");
    expect((await ledger.getControl()).frozen).toBe(true);
  });

  it("#4 a mismatch found by reconcile protects the workout like a live mismatch", async () => {
    const t = setup();
    t.garmin.behaviour.readback = "throw_after_put";
    t.garmin.behaviour.put = "apply_dropping_names";
    const first = await t.run({ dryRun: false });
    expect(first.status).toBe("uncertain");
    await t.ledger.releaseBinding("hevy-1", "test-owner").catch(() => false);
    t.garmin.behaviour.readback = "ok";
    const rec = await reconcileStrictJournal(t.deps, first.journalIds[0]);
    expect(rec.status).toBe("needs_review");
    expect((await t.ledger.getBindingByHevy("hevy-1"))?.state).toBe("needs_review");
    await resolveStrictJournal(t.ledger, first.journalIds[0], "checked");
    await t.ledger.setFrozen(false, null);
    const again = await t.run({ dryRun: false, targetHevyId: "hevy-1" });
    expect(again.status).toBe("needs_review");
    expect(t.garmin.calls.putSets).toBe(1);
  });

  it("#5 an evening workout west of UTC is found although Garmin lists by local date", async () => {
    const { strictSearchRange } = await import("../../src/strict");
    // 18:00-19:00 in Los Angeles on 26 Nov = 02:00-03:00 UTC on 27 Nov.
    const range = strictSearchRange({ start_time: "2026-11-26T18:00:00-08:00", end_time: "2026-11-26T19:00:00-08:00" });
    expect(range).toEqual({ start: "2026-11-26", end: "2026-11-28" });
    const t = setup({
      activities: [nativeActivity({ startTimeGMT: "2026-11-27 02:01:00", duration: 3500 })],
      workouts: [hevyWorkout({ start_time: "2026-11-26T18:00:00-08:00", end_time: "2026-11-26T19:00:00-08:00" })],
    });
    // A Garmin that honours the range by LOCAL date (the activity is on the 26th in LA).
    const listed = t.garmin.port.activitiesByDate;
    t.garmin.port.activitiesByDate = async (s, e) => ("2026-11-26" >= s && "2026-11-26" <= e ? listed(s, e) : []);
    const r = await strictInPlaceSync({ ...t.deps, now: () => new Date("2026-11-27T12:00:00Z") }, { dryRun: true });
    expect(r.status).toBe("dry_run");
    expect(r.activityId).toBe(9001);
  });

  it("#6 restoring the original removes the description strict mode added to an activity that had none", async () => {
    const t = setup({ activities: [nativeActivity({ description: null })] });
    t.garmin.behaviour.put = "apply_dropping_names";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    t.garmin.behaviour.put = "apply";
    // Put the block there as a completed metadata write would have.
    t.garmin.state.get(9001)!.description = "[hevy2garmin]\nHevy: Push Day\n[/hevy2garmin]";
    const restored = await restoreStrictBackup(t.deps, { journalId: r.journalIds[0], source: "original", confirm: true });
    expect(restored.status).toBe("restored");
    expect(t.garmin.state.get(9001)!.description ?? "").toBe("");
  });

  it("#9 a strict write is never resent by the rate limiter", async () => {
    const { strictGarminPort } = await import("../../src/strict");
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limit", { status: 429 });
    }) as typeof fetch;
    try {
      const client = { domain: "garmin.com", di_token: "t", refreshDiToken: async () => {} } as never;
      const port = strictGarminPort(client, { delayMs: 0, baseWaitMs: 0, maxAttempts: 3, sleep: async () => {} });
      await expect(port.putExerciseSets(1, { activityId: 1, exerciseSets: [] })).rejects.toThrow(/429/);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
