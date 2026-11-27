/**
 * The durable state strict mode depends on (contract items 2 and 3).
 *
 *  bindings  one row per Hevy workout ↔ Garmin activity. BOTH ids are unique,
 *            so a workout is never written into two activities and an activity
 *            never receives two workouts. A claim is a single atomic insert or
 *            a conditional lease takeover of the same pair, never a
 *            read-then-write, so two processes cannot both win.
 *  backups   insert-only snapshots of an activity before it is written: the
 *            first one ever taken for an activity is its `original` and is
 *            never replaced; every write adds a `pre_write`. Implementations
 *            must refuse UPDATE and DELETE (the Postgres one with a trigger).
 *  journal   a write-ahead record per Garmin write. Its phase is advanced by
 *            compare-and-set, `put_sent` is durable BEFORE the request leaves,
 *            and any entry in an open phase blocks every further strict write
 *            until it is reconciled by read-back.
 *  control   a global freeze switch (the stop switch).
 *
 * Nothing here talks to Garmin.
 */

export type BindingState = "claimed" | "verified" | "needs_review";

export interface StrictBinding {
  hevyId: string;
  garminActivityId: number;
  state: BindingState;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastJournalId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ClaimOutcome =
  | { ok: true; binding: StrictBinding; created: boolean }
  | {
      ok: false;
      reason: "hevy_bound_elsewhere" | "activity_bound_elsewhere" | "lease_held" | "needs_review";
      binding: StrictBinding | null;
    };

export type BackupKind = "original" | "pre_write";

export interface StrictBackupInput {
  garminActivityId: number;
  hevyId: string;
  kind: BackupKind;
  /** `{ exerciseSets, activityName, description, preservedMetrics }` as read from Garmin. */
  payload: unknown;
  sha256: string;
}

export interface StrictBackup extends StrictBackupInput {
  id: string;
  capturedAt: string;
}

export type JournalStep = "exercise_sets" | "metadata" | "restore";

export type JournalPhase =
  | "intent" // recorded, nothing sent yet
  | "put_sent" // durable BEFORE the request leaves; outcome unknown until read back
  | "put_acknowledged" // Garmin answered 2xx, read-back pending
  | "uncertain" // error/timeout after sending; read-back decides
  | "needs_review" // read-back did not match; a person decides (stop switch engaged)
  | "verified" // read-back matched exactly
  | "not_applied" // read-back equals the pre-write backup: Garmin did not apply it
  | "restored" // an operator-approved restore was verified
  | "aborted" // closed before anything was sent
  | "resolved"; // closed by an operator after review

export const OPEN_PHASES: ReadonlySet<JournalPhase> = new Set(["intent", "put_sent", "put_acknowledged", "uncertain", "needs_review"]);
/** Phases in which Garmin may hold a state nobody has verified. They freeze all strict writes. */
export const BLOCKING_PHASES: ReadonlySet<JournalPhase> = new Set(["put_sent", "put_acknowledged", "uncertain", "needs_review"]);

export interface StrictJournalEntry {
  id: string;
  hevyId: string;
  garminActivityId: number;
  step: JournalStep;
  phase: JournalPhase;
  owner: string;
  intendedSha256: string;
  intended: unknown;
  backupId: string;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StrictJournalInput {
  hevyId: string;
  garminActivityId: number;
  step: JournalStep;
  owner: string;
  intendedSha256: string;
  intended: unknown;
  backupId: string;
  detail?: Record<string, unknown>;
}

export interface StrictControl {
  frozen: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export interface StrictLedger {
  getBindingByHevy(hevyId: string): Promise<StrictBinding | null>;
  getBindingByActivity(activityId: number): Promise<StrictBinding | null>;
  listBindings(): Promise<StrictBinding[]>;
  claimBinding(input: { hevyId: string; activityId: number; owner: string; now: Date; leaseMs: number }): Promise<ClaimOutcome>;
  /** Changes a binding only while `owner` holds its lease. */
  updateBinding(
    hevyId: string,
    owner: string,
    patch: Partial<Pick<StrictBinding, "state" | "lastJournalId" | "lastError">>,
  ): Promise<boolean>;
  /** Ends `owner`'s lease, applying `patch`. */
  releaseBinding(
    hevyId: string,
    owner: string,
    patch?: Partial<Pick<StrictBinding, "state" | "lastJournalId" | "lastError">>,
  ): Promise<boolean>;
  /** Reconciliation and operators: set state regardless of lease. */
  setBindingState(hevyId: string, state: BindingState, lastError: string | null): Promise<boolean>;

  saveBackup(input: StrictBackupInput): Promise<StrictBackup>;
  getBackup(id: string): Promise<StrictBackup | null>;
  getOriginalBackup(activityId: number): Promise<StrictBackup | null>;

  openJournal(input: StrictJournalInput): Promise<StrictJournalEntry>;
  /** Compare-and-set; true only when the entry was in one of `from`. */
  advanceJournal(id: string, from: JournalPhase[], to: JournalPhase, detail?: Record<string, unknown>): Promise<boolean>;
  getJournal(id: string): Promise<StrictJournalEntry | null>;
  listOpenJournal(): Promise<StrictJournalEntry[]>;
  listJournalForActivity(activityId: number): Promise<StrictJournalEntry[]>;

  getControl(): Promise<StrictControl>;
  setFrozen(frozen: boolean, reason: string | null): Promise<void>;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/**
 * Reference implementation for tests and single-process use. Every method
 * mutates synchronously after its last await, so it is atomic on the JS event
 * loop, mirroring what the database gives the Postgres implementation.
 */
export function memoryStrictLedger(clock: () => Date = () => new Date()): StrictLedger & { dump(): unknown } {
  const bindings = new Map<string, StrictBinding>();
  const backups = new Map<string, StrictBackup>();
  const journal = new Map<string, StrictJournalEntry>();
  let control: StrictControl = { frozen: false, reason: null, updatedAt: null };
  let seq = 0;
  const iso = () => clock().toISOString();
  const byActivity = (id: number) => [...bindings.values()].find((b) => b.garminActivityId === id) ?? null;

  return {
    dump: () => clone({ bindings: [...bindings.values()], backups: [...backups.values()], journal: [...journal.values()], control }),

    async getBindingByHevy(hevyId) {
      return clone(bindings.get(hevyId) ?? null);
    },
    async getBindingByActivity(activityId) {
      return clone(byActivity(activityId));
    },
    async listBindings() {
      return clone([...bindings.values()]);
    },
    async claimBinding({ hevyId, activityId, owner, now, leaseMs }) {
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const mine = bindings.get(hevyId) ?? null;
      const theirs = byActivity(activityId);
      if (!mine && !theirs) {
        const b: StrictBinding = {
          hevyId,
          garminActivityId: activityId,
          state: "claimed",
          leaseOwner: owner,
          leaseUntil,
          lastJournalId: null,
          lastError: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        bindings.set(hevyId, b);
        return { ok: true, binding: clone(b), created: true };
      }
      if (mine && mine.garminActivityId !== activityId) return { ok: false, reason: "hevy_bound_elsewhere", binding: clone(mine) };
      if (theirs && theirs.hevyId !== hevyId) return { ok: false, reason: "activity_bound_elsewhere", binding: clone(theirs) };
      const b = mine!;
      if (b.state === "needs_review") return { ok: false, reason: "needs_review", binding: clone(b) };
      const held = b.leaseOwner && b.leaseOwner !== owner && b.leaseUntil && Date.parse(b.leaseUntil) > now.getTime();
      if (held) return { ok: false, reason: "lease_held", binding: clone(b) };
      b.leaseOwner = owner;
      b.leaseUntil = leaseUntil;
      b.updatedAt = now.toISOString();
      return { ok: true, binding: clone(b), created: false };
    },
    async updateBinding(hevyId, owner, patch) {
      const b = bindings.get(hevyId);
      if (!b || b.leaseOwner !== owner) return false;
      Object.assign(b, clone(patch), { updatedAt: iso() });
      return true;
    },
    async releaseBinding(hevyId, owner, patch = {}) {
      const b = bindings.get(hevyId);
      if (!b || b.leaseOwner !== owner) return false;
      Object.assign(b, clone(patch), { leaseOwner: null, leaseUntil: null, updatedAt: iso() });
      return true;
    },
    async setBindingState(hevyId, state, lastError) {
      const b = bindings.get(hevyId);
      if (!b) return false;
      Object.assign(b, { state, lastError, updatedAt: iso() });
      return true;
    },

    async saveBackup(input) {
      if (input.kind === "original") {
        const existing = [...backups.values()].find(
          (x) => x.kind === "original" && x.garminActivityId === input.garminActivityId,
        );
        if (existing) return clone(existing);
      }
      const b: StrictBackup = deepFreeze({ ...clone(input), id: `bk_${++seq}`, capturedAt: iso() });
      backups.set(b.id, b);
      return clone(b);
    },
    async getBackup(id) {
      return clone(backups.get(id) ?? null);
    },
    async getOriginalBackup(activityId) {
      return clone([...backups.values()].find((x) => x.kind === "original" && x.garminActivityId === activityId) ?? null);
    },

    async openJournal(input) {
      const now = iso();
      const e: StrictJournalEntry = {
        ...clone(input),
        detail: clone(input.detail ?? {}),
        id: `jr_${++seq}`,
        phase: "intent",
        createdAt: now,
        updatedAt: now,
      };
      journal.set(e.id, e);
      return clone(e);
    },
    async advanceJournal(id, from, to, detail) {
      const e = journal.get(id);
      if (!e || !from.includes(e.phase)) return false;
      e.phase = to;
      e.updatedAt = iso();
      if (detail) e.detail = { ...e.detail, ...clone(detail) };
      return true;
    },
    async getJournal(id) {
      return clone(journal.get(id) ?? null);
    },
    async listOpenJournal() {
      return clone([...journal.values()].filter((e) => OPEN_PHASES.has(e.phase)));
    },
    async listJournalForActivity(activityId) {
      return clone([...journal.values()].filter((e) => e.garminActivityId === activityId));
    },

    async getControl() {
      return clone(control);
    },
    async setFrozen(frozen, reason) {
      control = { frozen, reason, updatedAt: iso() };
    },
  };
}
