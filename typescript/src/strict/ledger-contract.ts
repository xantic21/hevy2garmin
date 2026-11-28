/**
 * The behaviour every StrictLedger must have, as runnable cases. The engine
 * runs them against the in-memory ledger; the dashboard runs the same cases
 * against real Postgres, so the two cannot drift apart. No test framework is
 * imported: a failed expectation throws.
 */
import { isJournalConflict, type StrictLedger } from "./ledger";

export interface LedgerContractCase {
  name: string;
  run(make: () => Promise<StrictLedger>): Promise<void>;
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ledger contract: ${message}`);
}

const T0 = new Date("2026-03-10T18:00:00Z");
/** A syntactically valid SHA-256 for fixtures (the Postgres schema checks the format). */
const H = (n: number) => n.toString(16).padStart(64, "0");
const later = (ms: number) => new Date(T0.getTime() + ms);

export const STRICT_LEDGER_CONTRACT: LedgerContractCase[] = [
  {
    name: "a claim binds both ids exclusively",
    async run(make) {
      const l = await make();
      const a = await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "A", now: T0, leaseMs: 60_000 });
      check(a.ok && a.created, "first claim must create the binding");
      const otherActivity = await l.claimBinding({ hevyId: "h1", activityId: 102, owner: "B", now: T0, leaseMs: 60_000 });
      check(!otherActivity.ok && otherActivity.reason === "hevy_bound_elsewhere", "workout cannot bind a second activity");
      const otherWorkout = await l.claimBinding({ hevyId: "h2", activityId: 101, owner: "B", now: T0, leaseMs: 60_000 });
      check(!otherWorkout.ok && otherWorkout.reason === "activity_bound_elsewhere", "activity cannot receive a second workout");
      check((await l.getBindingByActivity(101))?.hevyId === "h1", "lookup by activity");
    },
  },
  {
    name: "concurrent claims of the same pair produce exactly one winner",
    async run(make) {
      const l = await make();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => l.claimBinding({ hevyId: "h1", activityId: 101, owner: `W${i}`, now: T0, leaseMs: 60_000 })),
      );
      check(results.filter((r) => r.ok).length === 1, `expected one winner, got ${results.filter((r) => r.ok).length}`);
      check(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "lease_held"), "losers see a held lease");
    },
  },
  {
    name: "concurrent claims of crossing pairs never double-bind",
    async run(make) {
      const l = await make();
      const results = await Promise.all([
        l.claimBinding({ hevyId: "h1", activityId: 101, owner: "A", now: T0, leaseMs: 60_000 }),
        l.claimBinding({ hevyId: "h2", activityId: 101, owner: "B", now: T0, leaseMs: 60_000 }),
        l.claimBinding({ hevyId: "h1", activityId: 102, owner: "C", now: T0, leaseMs: 60_000 }),
      ]);
      // Depending on arrival order either one claim wins, or two compatible
      // ones do (h2↔101 then h1↔102). What can never happen is a workout or
      // an activity bound twice, or a winner without its row.
      const winners = results.filter((r) => r.ok);
      check(winners.length >= 1 && winners.length <= 2, `unexpected number of winners: ${winners.length}`);
      const all = await l.listBindings();
      check(new Set(all.map((b) => b.hevyId)).size === all.length, "a workout is bound twice");
      check(new Set(all.map((b) => b.garminActivityId)).size === all.length, "an activity is bound twice");
      check(all.length === winners.length, "every winner has exactly one row and no loser has one");
      for (const w of winners) {
        if (!w.ok) continue;
        check(all.some((b) => b.hevyId === w.binding.hevyId && b.garminActivityId === w.binding.garminActivityId), "winner row missing");
      }
    },
  },
  {
    name: "a lease is exclusive until it expires, then the same pair can be resumed",
    async run(make) {
      const l = await make();
      await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "A", now: T0, leaseMs: 60_000 });
      check(!(await l.updateBinding("h1", "B", { lastError: "x" })), "non-owner cannot update");
      check(await l.updateBinding("h1", "A", { lastError: "y" }), "owner can update");
      const early = await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "B", now: later(30_000), leaseMs: 60_000 });
      check(!early.ok, "held lease refuses a second owner");
      const late = await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "B", now: later(61_000), leaseMs: 60_000 });
      check(late.ok && !late.created, "expired lease can be taken over for the same pair");
      check(await l.releaseBinding("h1", "B", { state: "verified" }), "owner releases");
      const b = await l.getBindingByHevy("h1");
      check(b?.state === "verified" && b.leaseOwner === null, "release clears the lease");
    },
  },
  {
    name: "a binding that needs review refuses every claim",
    async run(make) {
      const l = await make();
      await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "A", now: T0, leaseMs: 1 });
      await l.setBindingState("h1", "needs_review", "mismatch");
      const r = await l.claimBinding({ hevyId: "h1", activityId: 101, owner: "A", now: later(10_000), leaseMs: 60_000 });
      check(!r.ok && r.reason === "needs_review", "needs_review blocks claims");
    },
  },
  {
    name: "the first backup of an activity is its original and is never replaced",
    async run(make) {
      const l = await make();
      const first = await l.saveBackup({ garminActivityId: 101, hevyId: "h1", kind: "original", payload: { v: 1 }, sha256: H(1) });
      const second = await l.saveBackup({ garminActivityId: 101, hevyId: "h1", kind: "original", payload: { v: 2 }, sha256: H(2) });
      check(second.id === first.id && JSON.stringify(second.payload) === JSON.stringify({ v: 1 }), "original is kept");
      const pre1 = await l.saveBackup({ garminActivityId: 101, hevyId: "h1", kind: "pre_write", payload: { v: 3 }, sha256: H(3) });
      const pre2 = await l.saveBackup({ garminActivityId: 101, hevyId: "h1", kind: "pre_write", payload: { v: 4 }, sha256: H(4) });
      check(pre1.id !== pre2.id, "every pre_write is a new row");
      const back = await l.getBackup(pre1.id);
      check(back?.sha256 === H(3) && JSON.stringify(back.payload) === JSON.stringify({ v: 3 }), "backup reads back unchanged");
      check((await l.getOriginalBackup(101))?.id === first.id, "original lookup");
    },
  },
  {
    name: "journal phases advance only by compare-and-set",
    async run(make) {
      const l = await make();
      const e = await l.openJournal({ hevyId: "h1", garminActivityId: 101, step: "exercise_sets", owner: "A", intendedSha256: H(9), intended: { a: 1 }, backupId: "b" });
      check(e.phase === "intent", "opens in intent");
      check(await l.advanceJournal(e.id, ["intent"], "put_sent"), "intent → put_sent");
      check(!(await l.advanceJournal(e.id, ["intent"], "put_sent")), "second identical transition fails");
      const racers = await Promise.all([
        l.advanceJournal(e.id, ["put_sent"], "put_acknowledged"),
        l.advanceJournal(e.id, ["put_sent"], "uncertain"),
      ]);
      check(racers.filter(Boolean).length === 1, "exactly one concurrent transition wins");
      const open = await l.listOpenJournal();
      check(open.some((x) => x.id === e.id), "unverified entry is open");
      const cur = (await l.getJournal(e.id))!;
      check(await l.advanceJournal(e.id, [cur.phase], "verified", { note: "ok" }), "close");
      check(!(await l.listOpenJournal()).some((x) => x.id === e.id), "verified entry is closed");
      check(((await l.getJournal(e.id))?.detail as Record<string, unknown>).note === "ok", "detail merged");
      check((await l.listJournalForActivity(101)).length === 1, "lookup by activity");
    },
  },
  {
    name: "an activity lock has one holder; it can be extended by its owner and taken over only after expiry",
    async run(make) {
      const l = await make();
      const racers = await Promise.all(
        (["sync", "restore", "reconcile", "restore", "sync"] as const).map((purpose, i) =>
          l.acquireActivityLock({ activityId: 77, owner: `o${i}`, purpose, now: T0, leaseMs: 60_000 }),
        ),
      );
      const winners = racers.filter((r) => r.ok);
      check(winners.length === 1, `expected one lock holder, got ${winners.length}`);
      const holder = (await l.getActivityLock(77))!;
      check(racers.filter((r) => !r.ok).every((r) => !r.ok && r.heldBy?.owner === holder.owner), "losers see the holder");
      check((await l.acquireActivityLock({ activityId: 77, owner: holder.owner, purpose: holder.purpose, now: later(1000), leaseMs: 60_000 })).ok, "owner extends");
      check(!(await l.releaseActivityLock(77, "intruder")), "only the owner releases");
      check(!(await l.acquireActivityLock({ activityId: 77, owner: "late", purpose: "sync", now: later(30_000), leaseMs: 60_000 })).ok, "live lease refuses");
      check((await l.acquireActivityLock({ activityId: 77, owner: "late", purpose: "sync", now: later(120_000), leaseMs: 60_000 })).ok, "expired lease can be taken over");
      check(await l.releaseActivityLock(77, "late"), "owner releases");
      check((await l.getActivityLock(77)) === null, "released");
      check((await l.acquireActivityLock({ activityId: 78, owner: "x", purpose: "restore", now: T0, leaseMs: 60_000 })).ok, "other activities are independent");
    },
  },
  {
    name: "fencing: a lock renews only while continuously held; an expired or taken-over lease never revives",
    async run(make) {
      const l = await make();
      const a = await l.acquireActivityLock({ activityId: 81, owner: "A", purpose: "sync", now: T0, leaseMs: 60_000 });
      check(a.ok, "A holds");
      const acquiredAt = (a as { lock: { acquiredAt: string } }).lock.acquiredAt;
      check(await l.renewActivityLock({ activityId: 81, owner: "A", acquiredAt, now: later(30_000), leaseMs: 60_000 }), "renews while held");
      check(!(await l.renewActivityLock({ activityId: 81, owner: "B", acquiredAt, now: later(31_000), leaseMs: 60_000 })), "another owner cannot renew");
      check(!(await l.renewActivityLock({ activityId: 81, owner: "A", acquiredAt, now: later(200_000), leaseMs: 60_000 })), "an expired lease is not revived");
      // Taken over and released by someone else in between: A's acquisition is gone for good.
      check((await l.acquireActivityLock({ activityId: 81, owner: "R", purpose: "restore", now: later(200_000), leaseMs: 60_000 })).ok, "R takes over");
      check(await l.releaseActivityLock(81, "R"), "R releases");
      check(!(await l.renewActivityLock({ activityId: 81, owner: "A", acquiredAt, now: later(201_000), leaseMs: 60_000 })), "A cannot renew after an interleaving");
    },
  },
  {
    name: "a writer's release never lifts a review set meanwhile",
    async run(make) {
      const l = await make();
      check((await l.claimBinding({ hevyId: "rv", activityId: 82, owner: "W", now: T0, leaseMs: 60_000 })).ok, "claimed");
      check(await l.setBindingState("rv", "needs_review", "restored by an operator"), "review set");
      await l.releaseBinding("rv", "W", { state: "verified", lastError: null });
      const b = await l.getBindingByHevy("rv");
      check(b?.state === "needs_review", `release lifted the review: ${b?.state}`);
      check(b?.leaseOwner === null, "lease released");
    },
  },
  {
    name: "at most one write in flight per activity, even under concurrency",
    async run(make) {
      const l = await make();
      const base = { hevyId: "h1", garminActivityId: 90, step: "exercise_sets" as const, owner: "A", intendedSha256: H(5), intended: {}, backupId: "b" };
      const opened = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => l.openJournal({ ...base, owner: `W${i}` })));
      const ok = opened.filter((r) => r.status === "fulfilled");
      check(ok.length === 1, `expected one in-flight entry, got ${ok.length}`);
      check(opened.filter((r) => r.status === "rejected").every((r) => isJournalConflict((r as PromiseRejectedResult).reason)), "losers get a journal conflict");
      const first = (ok[0] as PromiseFulfilledResult<{ id: string }>).value;
      await l.advanceJournal(first.id, ["intent"], "put_sent");
      let blocked = false;
      try {
        await l.openJournal(base);
      } catch (e) {
        blocked = isJournalConflict(e);
      }
      check(blocked, "a put_sent entry still blocks a second write");
      await l.advanceJournal(first.id, ["put_sent"], "needs_review");
      const restore = await l.openJournal({ ...base, step: "restore" });
      check(restore.phase === "intent", "a reviewed (needs_review) entry admits the controlled restore");
      check((await l.openJournal({ ...base, garminActivityId: 91 })).phase === "intent", "other activities are independent");
    },
  },
  {
    name: "the stop switch persists",
    async run(make) {
      const l = await make();
      check(!(await l.getControl()).frozen, "starts open");
      await l.setFrozen(true, "read-back mismatch");
      const c = await l.getControl();
      check(c.frozen && c.reason === "read-back mismatch", "freeze persisted with its reason");
      await l.setFrozen(false, null);
      check(!(await l.getControl()).frozen, "unfreeze");
    },
  },
];
