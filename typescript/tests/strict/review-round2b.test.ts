/**
 * Re-audit #2 of review round 2: every finding as a test that fails on the
 * code before its fix, and the negative controls the re-audit found missing.
 */
import { describe, expect, it } from "vitest";
import {
  compareSetSequences,
  memoryStrictLedger,
  reconcileStrictJournal,
  restoreStrictBackup,
  strictHardStopActive,
  strictInPlaceSync,
  type StrictLedger,
  type StrictSyncOptions,
} from "../../src/strict";
import { createFakeGarmin, fakeLegacy, hevyWorkout, nativeActivity, NOW } from "./fake-garmin";

function setup(workouts: Array<Record<string, unknown>> = [hevyWorkout()]) {
  let t = NOW.getTime();
  const clock = () => new Date(t);
  const garmin = createFakeGarmin([nativeActivity()]);
  const legacy = fakeLegacy();
  const ledger = memoryStrictLedger(clock);
  let ws = workouts;
  const deps = { ledger, legacy: legacy.store, garmin: async () => garmin.port, fetchWorkouts: async () => ws as never, now: clock, sleep: async () => {}, owner: "sync-A" };
  const restoreDeps = (over: Record<string, unknown> = {}) => ({ ledger, garmin: async () => garmin.port, now: clock, sleep: async () => {}, owner: "restore-B", ...over });
  return {
    garmin,
    legacy,
    ledger,
    deps,
    clock,
    restoreDeps,
    advance: (ms: number) => (t += ms),
    setWorkouts: (w: typeof ws) => (ws = w),
    run: (o: StrictSyncOptions = {}, d: typeof deps = deps) => strictInPlaceSync(d, { verifyDelayMs: 0, ...o }),
  };
}

/** A ledger that calls `hook` before delegating `method`, once. */
function hookOnce<K extends keyof StrictLedger>(ledger: StrictLedger, method: K, when: (...a: unknown[]) => boolean, hook: () => Promise<unknown>): StrictLedger {
  let fired = false;
  return new Proxy(ledger, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (prop !== method) return v.bind(target);
      return async (...a: unknown[]) => {
        if (!fired && when(...a)) {
          fired = true;
          await hook();
        }
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  });
}

async function reviewed() {
  const t = setup();
  t.garmin.behaviour.put = "apply_dropping_names";
  const r = await t.run({ dryRun: false });
  expect(r.status).toBe("needs_review");
  t.garmin.behaviour.put = "apply";
  return { t, journalId: r.journalIds[0] };
}

describe("HIGH: the lock covers read → plan → write (TOCTOU)", () => {
  for (const changeReps of [false, true]) {
    it(`a restore that finishes between the sync's read and its lock: nothing is written, the review stays (changeReps=${changeReps})`, async () => {
      const t = setup();
      const first = await t.run({ dryRun: false });
      expect(first.status).toBe("synced");
      if (changeReps) {
        const w = hevyWorkout();
        (w.exercises as Array<{ sets: Array<{ reps: number }> }>)[0].sets[1].reps = 9;
        t.setWorkouts([w]);
      }
      let restore: { status: string } | null = null;
      const hooked = hookOnce(t.ledger, "acquireActivityLock", (input) => (input as { owner: string }).owner === "sync-A", async () => {
        restore = await restoreStrictBackup(t.restoreDeps(), { journalId: first.journalIds[0], source: "original", confirm: true }, { verifyDelayMs: 0 });
      });
      const writesBefore = t.garmin.writes();
      const marked = t.legacy.marked.length;
      const r = await t.run({ dryRun: false, targetHevyId: "hevy-1", resync: true }, { ...t.deps, ledger: hooked });
      expect(restore!.status).toBe("restored");
      expect(["needs_review", "blocked"]).toContain(r.status);
      expect(r.writes).toBe(0);
      // Only the restore wrote (sets, and the name/description back).
      expect(t.garmin.writes() - writesBefore).toBe(2);
      expect(t.garmin.state.get(9001)!.sets).toEqual([]);
      expect((await t.ledger.getBindingByHevy("hevy-1"))?.state).toBe("needs_review");
      expect(t.legacy.marked.length).toBe(marked);
    });
  }

  it("an activity changed by someone else between read and lock is not written", async () => {
    const t = setup();
    const hooked = hookOnce(t.ledger, "acquireActivityLock", () => true, async () => {
      t.garmin.state.get(9001)!.description = "edited on the phone meanwhile";
    });
    const r = await t.run({ dryRun: false }, { ...t.deps, ledger: hooked });
    expect(r).toMatchObject({ status: "blocked", writes: 0 });
    expect(r.reason).toMatch(/changed after this run read it/);
    expect(t.garmin.writes()).toBe(0);
    expect(await t.ledger.listJournalForActivity(9001)).toEqual([]);
  });
});

describe("MEDIUM: leases are fenced", () => {
  it("a lease that lapses mid-sync never writes again, even after an interleaved restore released the activity", async () => {
    const t = setup();
    const first = await t.run({ dryRun: false, metadata: { rename: false, description: false } });
    expect(first.status).toBe("synced");
    const w = hevyWorkout();
    (w.exercises as Array<{ sets: Array<{ reps: number }> }>)[0].sets[1].reps = 9;
    t.setWorkouts([w]);
    let restore: { status: string } | null = null;
    const hooked = hookOnce(t.ledger, "openJournal", (input) => (input as { step: string }).step === "metadata", async () => {
      t.advance(120_000); // the sync's 60 s leases have expired
      restore = await restoreStrictBackup(t.restoreDeps(), { journalId: first.journalIds[0], source: "original", confirm: true }, { verifyDelayMs: 0 });
    });
    const metaBefore = t.garmin.calls.putMeta;
    const r = await t.run({ dryRun: false, targetHevyId: "hevy-1", resync: true, leaseMs: 60_000 }, { ...t.deps, ledger: hooked });
    expect(restore!.status).toBe("restored");
    expect(r.status).not.toBe("synced");
    expect(r.reason).toMatch(/lock lapsed/);
    // The first sync renamed nothing, so the restore had no name to put back; the
    // resync would have renamed, but sent nothing once its lease had lapsed.
    expect(t.garmin.calls.putMeta - metaBefore).toBe(0);
    expect(t.garmin.state.get(9001)!.activityName).toBe("Strength");
    expect(t.garmin.state.get(9001)!.sets).toEqual([]);
    expect((await t.ledger.getBindingByHevy("hevy-1"))?.state).toBe("needs_review");
  });
});

describe("MEDIUM: reconciling a crashed restore keeps the operator's review", () => {
  it("verified by read-back: the reviewed entry is restored, the workout stays under review, a manual sync cannot write", async () => {
    const { t, journalId } = await reviewed();
    const crashed = await restoreStrictBackup(
      t.restoreDeps({ sleep: async () => { throw new Error("process killed before read-back"); } }),
      { journalId, source: "original", confirm: true },
      { verifyDelayMs: 1 },
    ).catch((e) => ({ status: `crashed: ${(e as Error).message}` }));
    expect(crashed.status).toMatch(/crashed/);
    const open = (await t.ledger.listOpenJournal()).find((e) => e.step === "restore")!;
    t.advance(11 * 60_000);
    const rec = await reconcileStrictJournal({ ledger: t.ledger, garmin: async () => t.garmin.port, now: t.clock }, open.id);
    expect(rec).toMatchObject({ status: "verified", writes: 0 });
    expect((await t.ledger.getJournal(journalId))?.phase).toBe("restored");
    expect((await t.ledger.getBindingByHevy("hevy-1"))?.state).toBe("needs_review");
    const writes = t.garmin.writes();
    const again = await t.run({ dryRun: false, targetHevyId: "hevy-1" });
    expect(again.writes).toBe(0);
    expect(t.garmin.writes()).toBe(writes);
  });
});

describe("MEDIUM: the name/description step re-verifies the sets", () => {
  it("a metadata write that clears the sets is a mismatch, never 'synced'", async () => {
    const t = setup();
    const orig = t.garmin.port.updateActivityMetadata;
    (t.garmin.port as { updateActivityMetadata: typeof orig }).updateActivityMetadata = async (id, f) => {
      await orig(id, f);
      t.garmin.state.get(id)!.sets = [];
    };
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("needs_review");
    expect(r.mismatches?.sets.length).toBeGreaterThan(0);
    expect((await t.ledger.getControl()).frozen).toBe(true);
  });

  it("…and reconcile of a metadata entry checks the sets too", async () => {
    const t = setup();
    t.garmin.behaviour.meta = "timeout_applied";
    const orig = t.garmin.port.updateActivityMetadata;
    (t.garmin.port as { updateActivityMetadata: typeof orig }).updateActivityMetadata = async (id, f) => {
      try {
        await orig(id, f);
      } finally {
        t.garmin.state.get(id)!.sets = [];
      }
    };
    t.garmin.behaviour.readback = "throw_after_put";
    const r = await t.run({ dryRun: false });
    expect(["uncertain", "needs_review"]).toContain(r.status);
    const open = (await t.ledger.listOpenJournal()).find((e) => e.step === "metadata");
    if (!open) return; // the sets step already caught it
    t.garmin.behaviour.readback = "ok";
    t.advance(11 * 60_000);
    const rec = await reconcileStrictJournal({ ledger: t.ledger, garmin: async () => t.garmin.port, now: t.clock }, open.id);
    expect(rec.status).toBe("needs_review");
  });
});

describe("LOW: a restore leaves nothing of the overwritten state behind", () => {
  it("absentMeansNull: a field the backup lacks must hold no value on Garmin", () => {
    const intended = { exerciseSets: [{ setType: "ACTIVE", exercises: [{ category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS" }] }] };
    const readback = {
      exerciseSets: [
        { setType: "ACTIVE", startTime: "2026-01-01T00:00:00.0", duration: 99, repetitionCount: 12, weight: 100000, wktStepIndex: 7, exercises: [{ category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS", probability: 3 }] },
      ],
    };
    expect(compareSetSequences(intended, readback)).toEqual([]); // a sync compares what it sent
    const fields = compareSetSequences(intended, readback, { absentMeansNull: true }).map((m) => m.field).sort();
    expect(fields).toEqual(["duration", "probability", "reps", "startTime", "weight", "wktStepIndex"]);
    const noExercises = { exerciseSets: [{ setType: "ACTIVE", exercises: null, repetitionCount: 5, weight: null }] };
    const leftover = { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: null, exercises: [{ category: "X", name: "Y" }] }] };
    expect(compareSetSequences(noExercises, leftover, { absentMeansNull: true }).map((m) => m.field)).toContain("exercises");
  });
});

describe("LOW: H2G_STRICT_STOP fails closed", () => {
  it.each(["1", "true", "on", "yes", "enabled", "stop", "y", "2", " STOP "])("%j stops", (v) => {
    expect(strictHardStopActive({ H2G_STRICT_STOP: v })).toBe(true);
  });
  it.each(["", "  ", "0", "false", "no", "off", "OFF", "False"])("%j does not", (v) => {
    expect(strictHardStopActive({ H2G_STRICT_STOP: v })).toBe(false);
  });
});

describe("negative controls the re-audit found missing", () => {
  it("category is compared", () => {
    const a = { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: 1000, exercises: [{ category: "BENCH_PRESS", name: null }] }] };
    const b = { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: 1000, exercises: [{ category: "SQUAT", name: null }] }] };
    expect(compareSetSequences(a, b).map((m) => m.field)).toEqual(["category"]);
  });

  it("an intended null never accepts a value (no weight is not 0 kg)", () => {
    const a = { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: null, exercises: [] }] };
    const b = { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: 0, exercises: [] }] };
    expect(compareSetSequences(a, b).map((m) => m.field)).toEqual(["weight"]);
  });

  it("a restore refuses a backup of another activity", async () => {
    const { t, journalId } = await reviewed();
    const ledger = new Proxy(t.ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== "getBackup" || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
        return async (id: string) => {
          const b = await (v as (x: string) => Promise<{ garminActivityId: number } | null>).call(target, id);
          return b ? { ...b, garminActivityId: 7777 } : b;
        };
      },
    });
    const writes = t.garmin.writes();
    const r = await restoreStrictBackup(t.restoreDeps({ ledger }), { journalId, source: "pre_write", confirm: true }, { verifyDelayMs: 0 });
    expect(r).toMatchObject({ status: "refused", writes: 0 });
    expect(t.garmin.writes()).toBe(writes);
  });

  it("a restore refuses when Garmin's answer names another activity", async () => {
    const { t, journalId } = await reviewed();
    const detail = t.garmin.port.activityDetail;
    t.garmin.port.activityDetail = async (id) => ({ ...(await detail(id)), activityId: 4242 });
    const writes = t.garmin.writes();
    const r = await restoreStrictBackup(t.restoreDeps(), { journalId, source: "original", confirm: true }, { verifyDelayMs: 0 });
    expect(r).toMatchObject({ status: "refused", writes: 0 });
    expect(t.garmin.writes()).toBe(writes);
  });

  it("a restore writes nothing when its own pre-restore backup does not verify", async () => {
    const { t, journalId } = await reviewed();
    let latest: string | null = null;
    const ledger = new Proxy(t.ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (prop === "saveBackup") {
          return async (input: unknown) => {
            const b = await (v as (x: unknown) => Promise<{ id: string }>).call(target, input);
            latest = b.id;
            return b;
          };
        }
        if (prop === "getBackup") {
          return async (id: string) => {
            const b = await (v as (x: string) => Promise<Record<string, unknown> | null>).call(target, id);
            return b && id === latest ? { ...b, payload: { ...(b.payload as object), activityName: "tampered" } } : b;
          };
        }
        return v.bind(target);
      },
    });
    const writes = t.garmin.writes();
    const r = await restoreStrictBackup(t.restoreDeps({ ledger }), { journalId, source: "original", confirm: true }, { verifyDelayMs: 0 });
    expect(r).toMatchObject({ status: "failed", writes: 0 });
    expect(t.garmin.writes()).toBe(writes);
  });

  it("a restore whose final transition to 'restored' is refused freezes writes for review", async () => {
    const { t, journalId } = await reviewed();
    await t.ledger.setFrozen(false, null);
    const ledger = new Proxy(t.ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (prop !== "advanceJournal") return v.bind(target);
        return async (id: string, from: string[], to: string, detail?: unknown) =>
          to === "restored" ? false : (v as (...x: unknown[]) => Promise<boolean>).call(target, id, from, to, detail);
      },
    });
    const r = await restoreStrictBackup(t.restoreDeps({ ledger }), { journalId, source: "original", confirm: true }, { verifyDelayMs: 0 });
    expect(r.status).toBe("needs_review");
    expect((await t.ledger.getControl()).frozen).toBe(true);
  });

  it("reconcile re-reads the entry under the lock and refuses when it moved", async () => {
    const t = setup();
    t.garmin.behaviour.put = "timeout_applied";
    t.garmin.behaviour.readback = "throw_after_put";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("uncertain");
    t.garmin.behaviour.readback = "ok";
    t.advance(11 * 60_000);
    const id = r.journalIds[0];
    let reads = 0;
    const ledger = new Proxy(t.ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (prop !== "getJournal") return v.bind(target);
        return async (jid: string) => {
          const e = await (v as (x: string) => Promise<Record<string, unknown> | null>).call(target, jid);
          reads += 1;
          return e && reads > 1 ? { ...e, phase: "verified" } : e; // moved by someone else meanwhile
        };
      },
    });
    const rec = await reconcileStrictJournal({ ledger, garmin: async () => t.garmin.port, now: t.clock }, id);
    expect(rec).toMatchObject({ status: "refused", writes: 0 });
    expect((await t.ledger.getJournal(id))?.phase).toBe("uncertain");
  });

  it("a sync sends nothing when intent → put_sent is refused", async () => {
    const t = setup();
    const ledger = new Proxy(t.ledger, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (prop !== "advanceJournal") return v.bind(target);
        return async (id: string, from: string[], to: string, detail?: unknown) =>
          to === "put_sent" ? false : (v as (...x: unknown[]) => Promise<boolean>).call(target, id, from, to, detail);
      },
    });
    const r = await t.run({ dryRun: false }, { ...t.deps, ledger });
    expect(r).toMatchObject({ status: "failed", writes: 0 });
    expect(t.garmin.writes()).toBe(0);
  });

  it("a restore starts only from a reviewed or verified entry", async () => {
    const t = setup();
    t.garmin.behaviour.put = "timeout_applied";
    t.garmin.behaviour.readback = "throw_after_put";
    const r = await t.run({ dryRun: false });
    expect(r.status).toBe("uncertain");
    t.garmin.behaviour.readback = "ok";
    const writes = t.garmin.writes();
    const out = await restoreStrictBackup(t.restoreDeps(), { journalId: r.journalIds[0], source: "original", confirm: true }, { verifyDelayMs: 0 });
    expect(out).toMatchObject({ status: "refused", writes: 0 });
    expect(out.reason).toMatch(/uncertain/);
    expect(t.garmin.writes()).toBe(writes);
  });
});
