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
| Exactly what was previewed (re-audit #3, F2) | the preview's `planSha256` (sets payload, new name, new description) travels with the run; the engine refuses a live pinned run without it or with a different plan, before any write | engine (missing, wrong, Hevy edited after the preview), e2e (mapping changed after the preview), HTTP | G26, G27, G28 |
| The database stays locked after gate F (re-audit #3, F1) | a database holding the gate F record refuses live sync, "Sync all", cron and restore unless gate F mode or the gate G cutover is set; blank variables count as unset | e2e | G24, G25 |
| Only the new, empty database (re-audit #3, F6) | guard before the schema bootstrap: an unmarked database with any row is refused, an empty one is marked | Postgres guard tests incl. the runtime path | G34, G35 |
| Never on a hosting platform; strict expiry (F4, F5) | hosting variables (`VERCEL*`, Lambda, Netlify, Render, Railway, Fly, Cloud Run, Heroku) refuse a real gate F; impossible dates and offsets refused | unit | G30, G31 (G09 now defence in depth) |
| Only from the dashboard itself (F9) | operator routes refuse another origin (403) and non-JSON bodies (415) | unit, HTTP | G32, G33 |
| Evidence (F3) | original backup (before), journaled intents with integrity check, fresh read (after), comparisons of sets, name, description and native metrics, a verdict that is OK only when every comparison for the expected state ran and passed, SHA-256 | e2e (verdict fails when Garmin's name was changed elsewhere; OK again after a restore), HTTP | G29 |

## 3. Qualification of the final candidate 7b63cbf

7b63cbf is the gate F pin. Compared with 8ebd30d (section 3b) it adds:

- the owner's **Restore original** in the gate F panel
- the Python CLI's owner-only, atomic config write (PES HEVY2GARMIN-F04)
- dashboard contrast and focusable table regions
- the browser gates: the gate F click path, accessibility and page timing
- six negative controls

The engine (`typescript/`), the gate F server logic and the strict dashboard
logic in `web/lib/` are unchanged. The intermediate candidate a1e9a2d was
reviewed by an independent auditor (section 4a); 7b63cbf closes its findings.
It was requalified in full on its own tree, on synthetic data only.

| Check | Result |
| --- | --- |
| Engine (`typescript/`) | unchanged since 8ebd30d: 617/617 carries over; the dashboard's copy is verified identical to the source ("Engine identity verified") |
| Dashboard (`web/`): tsc, eslint, vitest incl. Postgres and pg_dump/pg_restore | clean; clean; 1087/1087 (111 files) |
| Python: pytest SQLite / Postgres; ruff 0.16.7 check and format | 484 passed, 8 skipped / 491 passed, 1 skipped; clean |
| Playwright smoke (desktop + mobile) | 6/6 |
| Gate E over HTTP, production build (`staging-rehearsal.mjs`) | 38/38 |
| Gate F over HTTP, same build (`gate-f-rehearsal.mjs`) | 35/35. Garmin writes: one sets PUT and one name/description PUT on activity 9100001 for the run, the same two for the restore. No other write; only the two simulated hosts |
| The owner's gate F path in Chromium (`gate-f-ui-check.mjs`, fresh database) | 11/11: seed, panel shown, no restore before a write, preview, the run refused until the confirmation is typed exactly, synced, evidence downloaded with "verdict OK (merged)", restore offered and refused until `RESTORE <journal id>` is typed exactly, restored, evidence "verdict OK (original)", nothing left to restore and the record done. Refuses a used gate F database and a non-synthetic deployment (both controls run) |
| Accessibility (`a11y-scan.mjs`, axe-core 4.13.0, WCAG 2.0/2.1 A/AA, each page's initial state) | 0 violations on 30 page views: login and 7 pages on staging data at desktop 1280 px, mobile 390 px and reflow 320 px, plus the gate F panel. Every page answered 200 on its own path. Axe left 66 nodes undecided: 49 icon-only elements with no text, and 17 bottom-navigation labels under the translucent bar. Those labels were computed by hand against the darkest possible content behind the bar: 7.25:1 active, 5.57:1 inactive (AA needs 4.5) |
| Page performance (`perf-probe.mjs`, 20 warm loads per page, thresholds fixed beforehand in PES_EVIDENCE.md) | every page within them. Worst page `/dashboard`: TTFB median 50 ms, p95 65 ms (limits 300 / 800). Worst DOMContentLoaded p95 96 ms (limit 1500). Cold start to the first `/login` 0.9 s |
| Negative controls (`strict_mutations.py`, 102) | the new P01–P04 (config file rights, atomic write, no leftover file) and G36/G37 (the panel's restore) are all caught. The other 96 target files this delta does not touch, so their results carry over (section 3b): 98 + 2 documented equivalent. The harness now counts a Python control as caught only when pytest reports a failing test. Accessibility controls, run by hand on a rebuilt dashboard, are both caught: removing the focusable region (`scrollable-region-focusable`) and removing the mapping table's scroll container (reflow). The reflow control first exposed a check that could not fail, because mobile emulation widens the viewport; that was fixed. The history table's scroll container is an equivalent mutant, since that table fits at 320 px |
| Dependencies | dashboard `npm audit` 0, with axe-core 4.13.0 as a development dependency; engine and Python unchanged (0) |
| CI and the Vercel staging rehearsal of the pushed head | the PR #11 evidence comment. The head differs from 7b63cbf in Markdown files only. The Vercel staging preview of the documentation head 18d5243 (code a1e9a2d, `dpl_F2aSPGjMVpJ7mMBMtdJBFZSgadMb`): 38/38, with the bypass revoked right after (the revoked token gets 302) |

### 3b. The previous candidate 8ebd30d

The first candidate 6dd7002 passed the same checks (engine 610, dashboard 1044,
CI 11/11, gate E on Vercel 38/38) before the independent re-audit (section 4);
8ebd30d closes its findings and was requalified in full.

| Check | Result |
| --- | --- |
| Engine (`typescript/`): tsc, vitest | clean; 617/617 (27 gate F) |
| Dashboard (`web/`): engine identity, tsc, eslint, vitest incl. Postgres and pg_dump/pg_restore | verified; clean; clean; 1081/1081 (110 files, 0 skipped) |
| Negative controls, all (`strict_mutations.py`, 96 at the time) | 94 caught; 2 equivalent and documented: R1e (the dashboard's restore check behind the engine's) and G09 (the quarantine's Vercel check behind the gate F hosting check, G31). G03 survived once (the new plan requirement refused first) and is caught since a test runs a batch/cron trigger with a valid plan |
| Gate F over HTTP (production build, synthetic authorization, `gate-f-rehearsal.mjs`) | 35/35: every other sync path 423, five wrong confirmations, no plan, another plan, another origin (403), a non-JSON body (415) all refused without a write; one run synced; no repeat; verdict OK (merged); restore; verdict OK (original); only PUTs on the one activity |
| Gate E over HTTP, same build (`staging-rehearsal.mjs`) | 38/38 |
| Python: pytest SQLite / Postgres, ruff 0.16.7 | 480 passed, 8 skipped / 487 passed, 1 skipped (the read-only-folder test skips under root); clean |
| Playwright smoke (desktop + mobile) | 6/6 |
| Dependencies | engine and dashboard 0 vulnerabilities (vitest 5.0.5 / 4.1.12); pip-audit clean; Dependabot #1 (vitest < 3.2.6) concerns main only |
| `tools/gate-f/prepare-env.sh` | writes a file the gate F rules accept; refuses overwrite, synthetic ids, bad ids, non-Postgres URLs, > 14 days |

## 4. Independent re-audit #3 (separate agent, read-only, on 6dd7002)

Scope: every way to break the seven gate F guarantees, with probe tests
against a scratch database and a local server (all removed afterwards).
Could not be broken: no other route writes to Garmin in gate F mode; the proxy
cannot be bypassed through path variants (encoded slashes, `;` suffixes, case,
trailing slashes, `//`); parallel claims, stale takeover and a crash after
journaling end with one write or a freeze; recovery is limited to the pair; the
hard stop and the freeze hold; staging stays synthetic; gate F and gate G stay
separate.

| # | Severity | Finding | Closed by | Proof |
| --- | --- | --- | --- | --- |
| F1 | HIGH | "Once per database" held only while the four variables were set: without them (or blank), the same database accepted every manual sync and "Sync all" with the sealed real credentials | database lock after gate F (`gateFDatabaseLock`) on live sync and restore | e2e "F1" (sync, batch, restore blocked, blank variables, cutover unlocks); G24, G25 |
| F2 | MEDIUM | Preview and run were not bound: a mapping, setting or Hevy change between them wrote a different plan | plan hash from the preview, required and checked by the engine | engine and e2e "F2", HTTP; G26–G28 |
| F3 | LOW/MED | The evidence could look clean while name or description differed; the activity-id check was circular; journaled intents not integrity-checked; `null` vs `[]` ambiguous | name/description against the journaled write and the original, integrity of backup and journal, explicit verdict | e2e "F3"; G29 |
| F4 | LOW | Impossible expiry dates rolled over (31 Nov → 1 Dec, 24:00, +23:59) | strict parser | unit; G30 |
| F5 | LOW | "Never on Vercel" relied on two variables only | hosting-platform variables refused (any `VERCEL*`, Lambda, …); a real gate F remains the owner's choice of computer, documented | unit; G31 |
| F6 | LOW | Nothing enforced the new, empty database | gate F database guard before the bootstrap | guard tests; G34, G35 |
| F7 | INFO | A run whose record was taken over reported "synced" without the freeze | the run returns a warning, the panel shows it | e2e |
| F8 | INFO | Restore while frozen, unfreeze in gate F mode, token refresh during reads, staging seed resets the record | documented as intended (recovery, operator control, authentication, staging only) | STRICT_OPERATIONS.md §8 |
| F9 | LOW | Cross-site request forgery from another local port (`SameSite` treats ports as one site) | same-origin and JSON-only check on every operator route | unit, HTTP; G32, G33 |

## 4a. Independent final audit (separate agent, read-only, on a1e9a2d and its documentation)

Scope: the delta since 8ebd30d and the owner documentation. Engine and gate F
were not audited again (unchanged).

| # | Severity | Finding | Closed by |
| --- | --- | --- | --- |
| 1 | HIGH | The runbook's rollback after a run that reported success could not be done from the dashboard: "Restore backup…" appears only for uncertain writes | "4 · Restore original" in the gate F panel, its unit test and G36/G37, and the click-path check in CI; runbook step 18 |
| 2 | MEDIUM | `O_TRUNC` before `fchmod`: where `fchmod` fails (another owner, FAT, CIFS) `config.json` was left empty | atomic write via a 0600 temporary file with fsync and replace, falling back to the previous in-place write; tests for both paths and for a failed write; P01–P04 |
| 3 | MEDIUM | The config change looked outside the approved scope | recorded under contract item 7 (credential storage) in STRICT_MERGE_MIGRATION.md and AGENTS.md; listed as fork-specific in SECURITY.md. The PES register's F04 fix (no fork code change) is for the governance lane to update |
| 4 | MEDIUM | The merge step relied on the three required checks; "CI on that exact SHA" cannot hold for a commit that is not a PR head | runbook step 21: every check on the head green, and the head differs from the gate F commit in documentation only; AGENTS.md says "exact code tree" |
| 5 | MEDIUM | A rejected gate F did not say it must be repeated | runbook step 20: fix, new candidate, block B again with a new workout, database and `gate-f.env`, all before C |
| 6 | MEDIUM | Step 6 asked about a secret's value, which GitHub never shows | runbook: the secret held the legacy production connection string; rotate now, or record an explicit deferral |
| 7 | LOW | The scan could pass on an error page or a redirect; undecided nodes were ignored; it covers initial states only | page must answer 200 on its own path; undecided nodes recorded and assessed; wording "initial state" |
| 8 | LOW | The browser checks would also run against a real deployment | `browser-target.mjs` refuses anything but synthetic staging (controlled) |
| 9 | LOW | The browser step ran before the isolation proof; p95 of 10 is the maximum | isolation proof first; 20 loads |
| 10 | LOW | The tests depended on the umask; any exit counted as caught | umask fixture; pytest must report a failure |
| 11 | LOW | `gate-f.env` was not git-ignored | `/gate-f.env` in `.gitignore` |
| 12 | LOW | PES_EVIDENCE.md had no results or finding map | completed |
| 13 | LOW | "Exercise names shown" vs. the known "Unknown" display (upstream #325); step 4 had no deployment id | step 17 makes it an explicit owner decision; step 4 names `dpl_3xaUyy9uvxcNnJQPUYHnjeFJibjA` |
| 14 | INFO | Garmin token revocation by password change unverified; brand files wording; script header; axe-core moved down to 4.10.3; extra approval for unattributed commits | worded as unverified; corrected; corrected; 4.13.0; runbook step 21 |

## 5. Fresh cloud environment

A new Claude Code cloud session on the environment `hevy2garmin` (its setup
script installs and builds the engine and the dashboard) checked out the branch
and, without changing anything: the setup script had run; engine identity
verified; `tools/maintenance/local-test-db.sh` started a fresh local Postgres;
engine 610/610; dashboard tsc, eslint, 1044/1044 incl. Postgres and pg_dump;
`pip install -e ".[dev,cloud]"`, pytest 480 passed, 7 skipped, 1 failed — the
read-only-folder test, because the container runs as root. That test now skips
itself under root. `git status` clean.

## 6. CI and the Vercel staging preview of 8ebd30d

| Check | Result |
| --- | --- |
| GitHub Actions CI | 11/11 jobs green, incl. "Synthetic staging rehearsal (gate E)" with the step "Rehearse gate F over HTTP" and the container image |
| Gate E on the protected Vercel preview (`dpl_31VrTq6riv2Q1Lijz1qqUzA12B93`, `/api/version` = 8ebd30d) | 38/38 with a temporary automation bypass, revoked right after (the revoked token gets 302) |
| Same-origin check behind Vercel's proxy (signed-in session) | own origin 200, `https://evil.example` and `http://localhost:3000` 403, `text/plain` body 415 |
| Production project | unchanged: `updatedAt` 1795749432375, latest deployment `dpl_3xaUyy9uvxcNnJQPUYHnjeFJibjA`, no deployment since the baseline |

A real gate F is not rehearsed on Vercel by design (it refuses every hosting
platform); its synthetic rehearsal runs on the production build locally and in
CI.

## 7. What stays open

- **Gate F itself**: the real run, the owner's visual check on Garmin
  Connect (exercise names displayed) and acceptance. Untested by definition:
  Garmin's behaviour on a real activity.
- **Production hardening** (§14): owner steps, then a read-only check.
- **Gate G**: a separate pull request that lifts the build quarantine, and the
  owner's cutover and automation approvals.
