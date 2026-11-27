# Quarantined modernization — strict in-place merge

## Immutable inputs
- Previous fork main: `5e3656637b601c002659602efff82bb3428c9a35` (historical Python package 0.5.17).
- Upstream source: `drkostas/hevy2garmin@b44bdc7c3a34a40fac77c5ec5dd18209f02f6d21`; TypeScript source package 0.15.0, Next.js dashboard.
- The migration candidate preserves the original license and source attribution; fork-specific branding, security policy, safe branch cleanup, portfolio workflows and upstream-only PyPI guard are carried forward. The upstream README is preserved byte-for-byte in docs/brand/UPSTREAM_README_MIGRATION_SNAPSHOT.md.
- Upstream automation that publishes packages or acts on upstream repositories is not imported. CI is SHA-pinned, read-only and uses lockfile installs. Old required SQLite/Postgres checks are preserved.
- Vercel auto-deployment is disabled at both candidate root directories, cron removed, Next config blocks Vercel target builds. These are candidate quarantine controls, not evidence about the external Vercel project or the live deployment. No production merge or activation until isolation is verified.

## Strict mode acceptance contract
The initial pure matching and capability helpers are NOT wired into any live path. No sync is approved. The completed mode must:
1. Use one unambiguous original Garmin strength activity (positive native provenance, UTC start, finite timing, no heuristic date-only fallback); preserve the activity ID, HR and native metrics. Unknown/no match, ambiguity, unreadable state or API errors defer rather than upload.
2. Enforce an exclusive durable Hevy-to-Garmin binding and atomic cross-process claims for both IDs. Treat an old pending upload/replace as quarantined, never replay it automatically. Never automatically create a FIT activity or delete an activity in strict mode, including manual/batch/cron/webhook/retry/reconcile/resync/unsync paths and any other runtime entry point. Guard at the actual network boundary, not just UI or mergeOnly.
3. Before any mutation, persist and verify an immutable original-set backup and validated exercise mapping/units. Never overwrite the original with a partially merged copy. After PUT, read back every required field (exercise identifiers, order, sets, reps, weight, units); verify activity ID and preserved metrics. On uncertain outcome, retain backup/journal and block subsequent writes until reconciled. Use readback and controlled recovery instead of blindly retrying. Preserve native timing and existing user notes where appropriate; no misleading estimated HR/calories in descriptions. Distinguish zero/missing and warmups/failure/drop/cardio sets.
4. Ensure the dashboard consumes the exact qualified fork engine bytes, not a different registry build. The pinned upstream web package currently references hevy2garmin ^0.14.0; local 0.15.0 source modifications alone would not reach it. Solve with a reproducible local package dependency and consistent lockfiles, no publication of the upstream npm name.
5. Disable destructive routes and alternate Python/Expo/CLI paths in this deployment unless independently qualified. Strict mode does not silently revert to Replace/Describe/Upload. Dry-run is zero writes including DB and does not claim success. Every automatic path remains off until owner acceptance.
6. Read-only historical duplicate audit; never automatically remove old activities. Separate exact-ID approval and backup are needed for cleanup.
7. Qualify auth, credential storage, scoped tokens, no third-party telemetry by default, database schema/backup/restore, migration and rollback on synthetic data. Verify the fresh-empty DB, existing legacy DB, cron authentication, no live credentials in CI or previews. Review the upstream CUTOVER.md blockers #473 and #475 against current code/tests. Do not copy real data into this public repo.
8. Test adversarially: repeated/out-of-order/concurrent calls, delayed Garmin sync, no watch activity, unknown provenance, duplicate timestamps, same-day workouts, UTC/DST, API 401/429/5xx/timeouts, lost response after PUT, failed backup, incorrect/partial readback, process crash/restart, legacy pending records, cross-user/isolation boundaries. Assert zero upload/delete calls. CI must include required existing checks plus the exact runtime's TypeScript/web tests, synthetic Postgres and integration tests.
9. Verify complete candidate on isolated staging with synthetic data; later one explicitly approved real activity test with before/after evidence and no deletion. Only then activate automatic sync via separate owner gate. Preserve rollback and stop switch.
10. Follow-up: mapping coverage, clear pending/review/error history, accessible mobile dashboard, dependency updates, optional read-only downstream integration.

## Gates
A: snapshot and quarantine; B: end-to-end strict mode; C: synthetic migration and full CI; D: independent review; E: isolated staging; F: one owner-accepted activity; G: separate production activation. No live credentials, paid resources, package publishing or real workout data in this public repository. No production deployment until all relevant gates pass.

## Implementation status (development branch, synthetic data only)

Recorded by the single writer of `migration/strict-inplace-20261127`. The inputs and contract above are unchanged. Details and evidence: [STRICT_OPERATIONS.md](STRICT_OPERATIONS.md); independent review: [STRICT_REAUDIT.md](STRICT_REAUDIT.md).

| Item | Status | Where |
| --- | --- | --- |
| 1 one unambiguous native original, defer otherwise | implemented | `typescript/src/strict/strict-sync.ts`, `strict-merge-policy.ts` |
| 2 exclusive binding, atomic claims, no upload/delete on any path, guard at the network boundary | implemented | `strict/ledger.ts`, `web/lib/strict-ledger-store.ts`, `strict/firewall.ts`, `web/instrumentation.ts`, `web/proxy.ts`, route guards, `src/hevy2garmin/strict_mode.py` |
| 3 verified immutable backup, journal, full read-back, block on uncertainty, controlled recovery | implemented | `strict/strict-sync.ts` (reconcile, confirmed restore), `strict_backups` triggers |
| 4 dashboard runs the exact local engine | implemented | `file:../typescript` copy install, `web/scripts/verify-engine.mjs`, CI |
| 5 destructive routes and alternate paths off; dry run zero writes; automatic off | implemented | 423 routes and proxy, library guards, Python guard, owner gate |
| 6 read-only duplicate audit | implemented | `strict/duplicate-audit.ts`, `/api/strict/duplicate-audit` |
| 7 auth, credentials, schema, backup/restore, migration, rollback on synthetic data; #473/#475 | qualified on synthetic data | `web/lib/db-qualification.db.test.ts`, login hardening, CI production checks |
| 8 adversarial tests, CI incl. exact runtime, synthetic Postgres and integration | implemented | `typescript/tests/strict/*`, `web/**/*.strict.test.ts`, `*.db.test.ts` |
| 9 isolated staging, one approved real activity, separate activation | **owner gates E–G** | procedure in STRICT_OPERATIONS.md §7–8 |
| 10 follow-ups | partly | dashboard redesign done; Expo SDK major and mapping coverage growth remain |
