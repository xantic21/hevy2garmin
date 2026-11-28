/**
 * Gate F: the owner authorizes exactly one Hevy workout and one native Garmin
 * activity. With that pin the engine runs only a manual sync of that workout
 * into that activity, restores and reconciles only that activity's journal,
 * and refuses everything else before anything is written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryStrictLedger,
  reconcileStrictJournal,
  restoreStrictBackup,
  strictInPlaceSync,
  strictPinRefusal,
  type StrictPin,
  type StrictSyncOptions,
} from "../../src/strict";
import { createFakeGarmin, fakeLegacy, hevyWorkout, nativeActivity, NOW } from "./fake-garmin";

const PIN: StrictPin = { hevyId: "hevy-1", activityId: 9001 };

function setup(activities = [nativeActivity()], workouts: Array<Record<string, unknown>> = [hevyWorkout()]) {
  const t = NOW.getTime();
  const clock = () => new Date(t);
  const garmin = createFakeGarmin(activities);
  const ledger = memoryStrictLedger(clock);
  const legacy = fakeLegacy();
  const deps = (owner = "sync-A") => ({ ledger, legacy: legacy.store, garmin: async () => garmin.port, fetchWorkouts: async () => workouts as never, now: clock, sleep: async () => {}, owner });
  const recovery = (owner = "op-B") => ({ ledger, garmin: async () => garmin.port, now: clock, sleep: async () => {}, owner });
  const run = (o: StrictSyncOptions, owner?: string) => strictInPlaceSync(deps(owner), { verifyDelayMs: 0, ...o });
  const noGarminIo = () => Object.values(garmin.calls).every((n) => n === 0);
  /** Preview, then the live run bound to the previewed plan: what the gate F route does. */
  const previewThenRun = async (owner?: string) => {
    const p = await run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN });
    return run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: p.plan?.planSha256 }, owner);
  };
  return { garmin, ledger, run, recovery, noGarminIo, previewThenRun };
}

afterEach(() => vi.unstubAllEnvs());

describe("gate F pin: only the authorized pair, only a manual sync", () => {
  it("the authorized workout merges into the authorized activity (one sets write, one metadata write)", async () => {
    const t = setup();
    const r = await t.previewThenRun();
    expect(r.status).toBe("synced");
    expect(r.activityId).toBe(PIN.activityId);
    expect(t.garmin.calls.putSets).toBe(1);
    expect(t.garmin.calls.putMeta).toBeLessThanOrEqual(1);
    expect((await t.ledger.getBindingByHevy(PIN.hevyId))?.state).toBe("verified");
  });

  for (const trigger of ["batch", "cron", "webhook"] as const) {
    it(`refuses a ${trigger} run before any IO, even when automatic sync were enabled`, async () => {
      const t = setup();
      const r = await t.run({ dryRun: false, trigger, targetHevyId: PIN.hevyId, pin: PIN, automaticEnabled: true });
      expect(r.status).toBe("blocked");
      expect(r.reason).toMatch(/gate F/);
      expect(t.noGarminIo()).toBe(true);
      expect(await t.ledger.listBindings()).toEqual([]);
    });
  }

  for (const trigger of ["batch", "cron", "webhook"] as const) {
    it(`refuses a ${trigger} run even with the previewed plan in hand (no write)`, async () => {
      const t = setup();
      const plan = (await t.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN })).plan!;
      const r = await t.run({ dryRun: false, trigger, targetHevyId: PIN.hevyId, pin: PIN, automaticEnabled: true, expectPlanSha256: plan.planSha256 });
      expect(r.status).toBe("blocked");
      expect(r.reason).toMatch(/only a manual sync/);
      expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(0);
      expect(await t.ledger.listBindings()).toEqual([]);
    });
  }

  for (const target of [undefined, "hevy-2", "HEVY-1", "hevy-1 "]) {
    it(`refuses any other workout (${JSON.stringify(target)}) before any IO`, async () => {
      const t = setup();
      const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: target, pin: PIN });
      expect(r.status).toBe("blocked");
      expect(t.noGarminIo()).toBe(true);
    });
  }

  it("refuses a resync of the authorized workout", async () => {
    const t = setup();
    const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, resync: true, pin: PIN });
    expect(r.status).toBe("blocked");
    expect(t.noGarminIo()).toBe(true);
  });

  for (const bad of [{ hevyId: "", activityId: 9001 }, { hevyId: "hevy-1", activityId: 0 }, { hevyId: "hevy-1", activityId: Number.NaN }, { hevyId: "hevy-1", activityId: 9001.5 }]) {
    it(`refuses a malformed authorization ${JSON.stringify(bad)}`, async () => {
      expect(strictPinRefusal(bad, { trigger: "manual", targetHevyId: bad.hevyId })).toMatch(/malformed/);
      const t = setup();
      const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: bad.hevyId, pin: bad });
      expect(r.status).toBe("blocked");
      expect(t.noGarminIo()).toBe(true);
    });
  }

  it("a different activity than the authorized one is never written: needs review, no binding, no PUT", async () => {
    const t = setup([nativeActivity({ activityId: 9002 })]);
    for (const dryRun of [true, false]) {
      const r = await t.run({ dryRun, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: "0".repeat(64) });
      expect(r.status).toBe("needs_review");
      expect(r.reason).toMatch(/authorization names activity 9001.*9002/);
    }
    expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(0);
    expect(await t.ledger.listBindings()).toEqual([]);
  });

  it("no replay: a second authorized run after the verified merge writes nothing", async () => {
    const t = setup();
    const first = await t.previewThenRun();
    expect(first.status).toBe("synced");
    const puts = t.garmin.calls.putSets + t.garmin.calls.putMeta;
    // Replaying the very request that succeeded (same previewed plan).
    const again = await t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: first.plan!.planSha256 }, "sync-C");
    expect(again.status).toBe("already_synced");
    // A fresh preview of a merged workout offers no plan, so no new live run can even be formed.
    expect((await t.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN })).plan).toBeNull();
    expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(puts);
  });

  it("parallel authorized runs: exactly one sets write", async () => {
    const t = setup();
    const plan = (await t.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN })).plan!;
    const results = await Promise.all(
      ["sync-1", "sync-2", "sync-3"].map((owner) =>
        t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: plan.planSha256 }, owner),
      ),
    );
    expect(results.filter((r) => r.status === "synced")).toHaveLength(1);
    expect(t.garmin.calls.putSets).toBe(1);
  });

  it("the global hard stop still wins over the authorization", async () => {
    vi.stubEnv("H2G_STRICT_STOP", "1");
    const t = setup();
    const r = await t.previewThenRun();
    expect(r.status).not.toBe("synced");
    expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(0);
  });
});

describe("gate F pin: the live run is bound to the previewed plan", () => {
  it("a live pinned run without the previewed plan is refused before any IO", async () => {
    const t = setup();
    for (const expectPlanSha256 of [undefined, "", "abc", "Z".repeat(64)]) {
      const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256 });
      expect(r.status).toBe("blocked");
      expect(r.reason).toMatch(/plan from the preview/);
    }
    expect(t.noGarminIo()).toBe(true);
  });

  it("a different plan than the previewed one writes nothing", async () => {
    const t = setup();
    const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: "0".repeat(64) });
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/plan differs from the previewed one/);
    expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(0);
    expect(await t.ledger.listBindings()).toEqual([]);
  });

  it("the workout edited in Hevy after the preview: the old plan is refused, nothing written", async () => {
    const workouts = [hevyWorkout()];
    const t = setup([nativeActivity()], workouts);
    const plan = (await t.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN })).plan!;
    const sets = (workouts[0].exercises as Array<{ sets: Array<{ weight_kg: number }> }>)[0].sets;
    sets[0].weight_kg += 2.5;
    const r = await t.run({ dryRun: false, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, expectPlanSha256: plan.planSha256 });
    expect(r.status).toBe("blocked");
    expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(0);
  });

  it("the plan hash covers the sets, the new name and the new description", async () => {
    const a = setup();
    const b = setup();
    const pa = (await a.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN })).plan!;
    const pb = (await b.run({ dryRun: true, trigger: "manual", targetHevyId: PIN.hevyId, pin: PIN, metadata: { rename: false } })).plan!;
    expect(pa.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pa.intendedSha256).toBe(pb.intendedSha256);
    expect(pa.planSha256).not.toBe(pb.planSha256);
  });
});

describe("gate F pin: recovery only for the authorized pair", () => {
  async function reviewed() {
    const t = setup();
    t.garmin.behaviour.put = "apply_dropping_names";
    const r = await t.previewThenRun();
    expect(r.status).toBe("needs_review");
    t.garmin.behaviour.put = "apply";
    return { t, journalId: r.journalIds[0] };
  }

  it("restores the authorized activity to its original under the pin", async () => {
    const { t, journalId } = await reviewed();
    const puts = t.garmin.calls.putSets;
    const out = await restoreStrictBackup(t.recovery(), { journalId, source: "original", confirm: true }, { verifyDelayMs: 0, pin: PIN });
    expect(out.status).toBe("restored");
    expect(t.garmin.calls.putSets).toBe(puts + 1);
  });

  for (const other of [{ hevyId: "hevy-2", activityId: 9001 }, { hevyId: "hevy-1", activityId: 9002 }]) {
    it(`refuses restore and reconcile for an entry outside the pin ${JSON.stringify(other)}`, async () => {
      const { t, journalId } = await reviewed();
      const puts = t.garmin.calls.putSets + t.garmin.calls.putMeta;
      const reads = t.garmin.calls.sets + t.garmin.calls.detail;
      const restore = await restoreStrictBackup(t.recovery(), { journalId, source: "original", confirm: true }, { verifyDelayMs: 0, pin: other });
      expect(restore.status).toBe("refused");
      const reconcile = await reconcileStrictJournal(t.recovery(), journalId, { pin: other });
      expect(reconcile.status).toBe("refused");
      expect(t.garmin.calls.putSets + t.garmin.calls.putMeta).toBe(puts);
      expect(t.garmin.calls.sets + t.garmin.calls.detail).toBe(reads);
    });
  }
});
