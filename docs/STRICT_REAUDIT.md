# Strict in-place merge — independent re-audit (gate D)

**Date:** 2026-11-27 · **Scope:** branch `migration/strict-inplace-20261127`
after the strict implementation (commits up to `3880356`).

**Method:** a separate reviewer worked from the repository and the contract
only, without the implementer's conclusions. Its brief was to break strict mode:
find an upload, delete or other Garmin mutation, ledger or journal holes, dry-run
writes, auth gaps and data-model errors. It changed nothing and reproduced
every finding locally, using a fake client and database, the in-memory ledger,
or a direct probe.

**Headline:** the reviewer found **no runtime path that uploads a FIT activity
or deletes a Garmin activity** with no mode variables set. It also found **no
gaps** in:
- authentication of `/api/strict/*` and the strict route branches;
- the owner gate on cron and webhook;
- GitHub dispatch and setup;
- the atomicity of Postgres claims;
- the immutability of backups;
- units and mapping.

It reported nine defects. All nine are closed below, each with a regression
test that fails on the old code.

| # | Severity | Finding | Closure | Regression test |
| --- | --- | --- | --- | --- |
| 1 | High | **Python CLI in strict mode.** Strict mode refused each Garmin write, but the sync *flow* caught the refusal. With the "describe" strategy it recorded a false "synced" row. With "merge" it parked a pending row. The strict engine then quarantined those workouts for good. | Every Python engine entry point now refuses **before** any store access: `sync_one_workout`, `sync`, `finalize_pending`, `reconcile_pending`, all routine functions and `attempt_merge`. So does every CLI command that changes the ledger (`sync`, `sync-routines`, `unsync`, `reconcile`, `retry-failed`, `abandon-pending`, `mark-synced`, `skip`). Each exits with a clear error. | `tests/test_strict_mode.py`: entry points, merge path, CLI commands. Store, client and database are never touched. |
| 2 | Medium | **Firewall leniency.** An object it could not inspect as a URL passed as "not Garmin". A trailing-dot host (`garmin.com.`) passed. `X-HTTP-Method-Override: PUT` was trusted over a real `DELETE`. | A target that cannot be inspected is refused (default deny). URL-like objects are classified by their string form. Host names are normalised (case, trailing dots). A write is allowed only for a real `PUT`, or a real `POST` tunnelling `PUT`; the header never upgrades another method. | `tests/strict/firewall.test.ts`, "closed re-audit finding #2" |
| 3 | Medium | **Reconcile during an in-flight write.** It could close a `put_sent` entry as `not_applied` before the writer's request landed. The writer's failed compare-and-set was then ignored, which left a possibly applied write unblocked. | Reconcile refuses while the writer still holds its binding lease. If any closing transition fails its compare-and-set, the writer freezes all strict writes for review instead of trusting its own verdict. | `tests/strict/strict-sync.test.ts`, #3 (both cases) |
| 4 | Medium | **Reconcile mismatch left the binding `claimed`.** After the operator resolved the entry and lifted the freeze, a manual sync could write the activity again. | A reconcile mismatch sets the binding to `needs_review`, exactly as a live mismatch does. | `strict-sync.test.ts`, #4 (zero extra writes) |
| 5 | Medium | **Search range in UTC dates.** Garmin filters activities by local date, so an evening session west of UTC was never listed and stayed `pending` for ever. | `strictSearchRange` lists one day either side of the UTC dates, which covers UTC−12 to UTC+14. The matcher still decides on real instants, and the ambiguity checks now see the complete set. | `strict-sync.test.ts`, #5 (a fake that lists by local date) |
| 6 | Low–medium | **Restore-to-original left the added description.** This happened when the original activity had no description, but the restore still reported success. | Null and empty descriptions are treated as one value. Restoring an original without a description clears what strict mode added, and read-back verifies the cleared state. | `strict-sync.test.ts`, #6 |
| 7 | Low | **Dry run and the read-only audit wrote bookkeeping.** Fetching from Hevy recorded the key's status. | A dry run, the candidate list and the duplicate audit read Hevy through `fetchAllWorkoutsReadOnly`, which records nothing. *Accepted residual:* building the Garmin client may still persist refreshed tokens, which keeps the session valid. The first query of a process runs the idempotent schema bootstrap. Neither is sync state, and neither touches Garmin data. | `web/app/api/strict-reaudit.strict.test.ts`, #7 |
| 8 | Low | **`/api/workout/[id]/skip` was not locked.** It could delete a quarantined pending row, or overwrite a synced row. | In strict mode, skip is allowed only for an untouched workout: no pending row, no ledger row, no binding. Otherwise it returns 423. The dashboard no longer offers it for quarantined uploads. | `strict-reaudit.strict.test.ts`, #8 |
| 9 | Low | **The rate limiter could resend a strict write on 429.** That contradicts "never a blind retry". | The strict port paces writes but never resends them (`maxAttempts: 1`). A 429 on a write is an uncertain outcome, decided by read-back. | `strict-sync.test.ts`, #9 (one request) |

## Results after closure

- **Engine:** 533 tests.
- **Web:** 802 tests, plus the real-Postgres cases in CI.
- **pytest:** 477 on SQLite and 484 on Postgres. One upstream test fails only
  when run as root (`test_unwritable_folder_is_named`) and passes in CI.
- **Lint:** ruff, tsc and eslint all clean.

## What the review cannot cover

- **Garmin Connect's behaviour on a real account.** This covers name display
  on watch activities and the normalisation of null versus 0. Read-back fails
  closed here, so this is gate F (`STRICT_OPERATIONS.md` §8).
- **The external Vercel and Neon projects.** Gate E covers these, where the
  owner holds access.
