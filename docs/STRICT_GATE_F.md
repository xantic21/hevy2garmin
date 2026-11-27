# Gate F: one owner-authorized real activity — design and qualification

Branch `migration/strict-inplace-20261127`, draft PR #11. Design and the
owner's procedure: [STRICT_OPERATIONS.md §8](STRICT_OPERATIONS.md#8-one-owner-accepted-real-activity-gate-f);
production hardening: §14; the owner's steps: [OWNER_RUNBOOK.md](OWNER_RUNBOOK.md).
Synthetic data only throughout: no real credential was used, nothing reached
Garmin or Hevy, no production setting or database was changed.

## 1. The problem and the decision

The contract required one owner-accepted real activity (gate F) before
production, and kept every production deployment quarantined until after
gate F. A real write therefore had no permitted place to run. Gate F is now
its own owner authorization, separate from gate G:

| Decision | Reason |
| --- | --- |
| Runs on the owner's computer, from the qualified container image; refused on any Vercel runtime | no production deployment before gate G; the owner's own connection signs in to Garmin directly (no Worker), and staging never sees a real credential |
| A new, empty Neon database (free), later the gate G database | the legacy production database is never touched before gate G; the original backup and journal of the gate F activity stay where gate G runs |
| Four variables, all or none, expiry ≤ 14 days; anything contradictory stops the server | a forgotten or half-set authorization cannot write; gate G flags and plain credentials cannot be combined with it |
| Engine pin + dashboard locks + a single-row record | defence in depth: each layer alone refuses a second activity, a second run or an automatic trigger |

## 2. Guarantees and their proof

| Guarantee | Enforced by | Tests | Negative controls |
| --- | --- | --- | --- |
| Only the authorized workout, only into the authorized activity | engine `pin`: target and trigger checked before any IO; the matched activity must equal the authorized one | `gate-f-pin.test.ts` (wrong activity, other workout, malformed pin) | G01, G02 |
| Manual only; no batch, cron, webhook, resync | engine pin; proxy locks `/api/sync*` and `/api/cron/*` for every method; generic routes 423; `runStrictSync` refuses calls without the exact pin | engine, `gate-f.test.ts` (route policy), proxy, Postgres e2e | G03, G10, G11, G12, G13 |
| Once per database; no replay, no parallel run, no re-pointing after a write | `strict_gate_f` claimed by one statement; final once journaled; existing binding, activity lock, in-flight index | e2e: replay, re-point, three parallel runs → one sets PUT, stale takeover, takeover mid-run freezes | G14, G15, G19 |
| Deliberate | typed confirmation `GATE-F <hevyId> <activityId>` | e2e, HTTP rehearsal (five wrong confirmations) | G16 |
| Expiry | live run refused after expiry; preview, evidence, recovery stay | unit, e2e | G08, G17 |
| Hard stop and freeze never bypassed | refused before the claim; engine and firewall unchanged | engine, e2e | G18 |
| Recovery only for the authorized pair | engine restore/reconcile pin; dashboard restore, reconcile, resolve | engine, e2e (journal of another workout refused) | G04, G05, G21, G22 |
| No real gate F on Vercel; staging never with real data | runtime quarantine; synthetic ids only in staging, real ids only outside | unit, proxy | G09, G20 |
| Gate F ≠ gate G; credentials only sealed | forbidden variables; credentials key required | unit, proxy | G06, G07, G23 |
| Evidence | original backup (before), journaled intent, fresh read (after), comparisons, SHA-256 | e2e, HTTP rehearsal (before/after, after restore) | — |

## 3. Qualification of the candidate 6dd7002

| Check | Result |
| --- | --- |
| Engine (`typescript/`): tsc, vitest | clean; 610/610 (20 new) |
| Dashboard (`web/`): engine identity, tsc, eslint, vitest incl. Postgres and pg_dump/pg_restore | verified; clean; clean; 1044/1044 (108 files, 0 skipped) |
| Negative controls, gate F (`strict_mutations.py G`) | 23/23 caught |
| Negative controls touching changed files (A17, A18, A21, E01, E02) | caught (round 2 run); full list in STRICT_REAUDIT_ROUND2.md |
| Gate F over HTTP (production build, synthetic authorization, `gate-f-rehearsal.mjs`) | 31/31: every other sync path 423, five wrong confirmations refused, one run synced, no repeat, evidence, restore to original, only PUTs on the one activity |
| Gate E over HTTP, same build, no gate F (`staging-rehearsal.mjs`) | 38/38 |
| Gate F panel in a browser | renders the authorization and every safeguard; the run button stays disabled until the confirmation matches and after the run |
| Python: pytest SQLite / Postgres, ruff 0.16.7 | 480 passed, 7 skipped / 487 passed; clean (one root-only test fails locally as before; green in CI) |
| Playwright smoke (desktop + mobile) | 6/6 |
| Dependencies | engine and dashboard 0 vulnerabilities; pip-audit clean; Dependabot #1 (vitest < 3.2.6) concerns main only, fixed on this branch |
| `tools/gate-f/prepare-env.sh` | writes a file the gate F rules accept; refuses overwrite, synthetic ids, bad ids, non-Postgres URLs, > 14 days |

Pending at the time of writing, recorded in section 4 when done: GitHub
Actions CI on the candidate, the gate E rehearsal on the Vercel staging
preview of the candidate, the fresh cloud environment check, the independent
re-audit.

## 4. Independent re-audit, Vercel and CI

(Recorded after the runs complete.)

## 5. What stays open

- **Gate F itself**: the real run, the owner's visual check on Garmin
  Connect (exercise names displayed) and acceptance. Untested by definition:
  Garmin's behaviour on a real activity.
- **Production hardening** (§14): owner steps, then a read-only check.
- **Gate G**: a separate pull request that lifts the build quarantine, and the
  owner's cutover and automation approvals.
