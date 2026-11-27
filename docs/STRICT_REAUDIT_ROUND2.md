# Strict in-place merge — review round 2 and independent re-audit #2

Branch `migration/strict-inplace-20261127`, draft PR #11. Round 1 is in
[STRICT_REAUDIT.md](STRICT_REAUDIT.md); operations in
[STRICT_OPERATIONS.md](STRICT_OPERATIONS.md). Synthetic data only throughout:
no real credential was used, nothing contacted Garmin, Hevy or GitHub write
APIs, and no deployment was made.

## 1. The owner's seven findings (after the CI-verified re-audit on af76c03)

| # | Finding | Closed by | Proof |
| --- | --- | --- | --- |
| 1 | `H2G_STRICT_STOP` must stop every Garmin write, restore included, and differ from the DB freeze | Checked in the firewall (before any capability), the engine (sync before the ledger is touched, again before every write, restore before reading), the dashboard (live sync before DB/Hevy/Garmin, restore). Fail-closed parsing. The DB freeze still allows a verified restore | `tests/strict/strict-sync.test.ts` "review round 2", `review-round2b.test.ts` (parsing), `strict-e2e`, `staging.db` (no request at all); controls R1a–R1f, A09 |
| 2 | Restore with exclusive atomic claims, leases, checked journal transitions; no concurrent sync/restore/reconcile | `strict_activity_locks` (single-statement claim), one in-flight journal entry per activity (partial unique index), every transition compare-and-set; re-audit #2 added: the binding and the activity are re-read UNDER the lock before anything is written, every write first renews the lock only if held without interruption (fencing), a writer's release never lifts a review, reconcile of a restore keeps the review | ledger contract (memory + Postgres), `review-round2b.test.ts`, `strict-e2e` (3 concurrent restores → 1 PUT); controls R2a–R2g, A01–A06 |
| 3 | Read-back and restore fidelity over every exercise field and set/rest timing; missing values never pass | `compareSetSequences`: ACTIVE and REST, start time, duration, step index, reps, weight, every exercise (category, name, probability), identity; intended value missing from the read-back = mismatch; a restore also requires that nothing absent from the backup remains (absent = null); the name/description step re-verifies the sets | `strict-sync.test.ts`, `review-round2b.test.ts`; controls R3a–R3f, A07, A08 |
| 4 | Authenticated encryption for Garmin tokens and the Hevy key; separate keys, migration, rotation, encrypted backups | `credential-vault.ts` (AES-256-GCM, platform AAD, key ids, pinned 96-bit IV / 128-bit tag, strict base64, separation from every other secret by bytes), explicit compare-and-set migration/rotation of credential rows only, `EncryptedTokenStore`, routes refuse before sending anything without a key, `backup-crypt.mjs` (authenticated header, refuses empty/non-dump input) | vault unit/DB/route tests, `db-qualification` (pg_dump holds no secret; encrypted dump restores), `backup-crypt.test.ts`; controls R4a–R4i, A11–A15 |
| 5 | Dry-run limits (token refresh, schema bootstrap) documented correctly | STRICT_OPERATIONS.md §12a lists every residual with its trigger; two were removed (unchanged tokens are never rewritten; credential reads never write) | whole-database dry-run test, SELECT-only read test, token-row tests; controls R5a, R5b |
| 6 | Simple, permanent, cost-neutral deployment path; isolated synthetic staging | Vercel Hobby + Neon free + own Cloudflare Worker (§4); `H2G_STAGING=synthetic`: in-process simulator as the firewall's transport, credential routes 423 for every method, refuses real-credential variables, database guard before any DDL; build and **runtime** quarantine (only a synthetic-staging preview runs) | `staging.db.strict.test.ts` (tripwire network), CI "Synthetic staging rehearsal (gate E)", proxy and quarantine tests; controls R6a–R6h, A16–A21 |
| 7 | Negative controls for everything; requalify the exact final candidate | `tools/maintenance/strict_mutations.py` (section 3) | section 3, section 4 |

## 2. Independent re-audit #2 (separate agent, read-only, on 440f4d4)

Verdict before this closing round: 1 closed (minor gaps), 2–7 partially
closed, one new HIGH. Every item and its closure:

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| HIGH | The activity lock did not cover read → plan → write: a restore finishing in between let a resync report `verified` over the restored original, or back up a stale state | Under the lock, before any write: the binding must still be this run's and not under review, and the activity's sets, name, description and native metrics must equal what was planned from; otherwise nothing is written | `review-round2b` "TOCTOU" (both variants, from the auditor's probe), A01, A02 |
| MEDIUM | Leases were never renewed or fenced | `renewActivityLock` succeeds only for the same owner, the same acquisition and an unexpired lease; called before every journal entry, again right before each request leaves, and before the final record | ledger contract "fencing", `review-round2b` "lease lapses mid-sync", A03, A04 |
| MEDIUM | Reconciling a crashed restore set the binding to `claimed` and left the reviewed entry unrestored | Reconcile of a `restore` entry closes the reviewed entry as `restored` (verified) and always keeps the workout under review | `review-round2b` "crashed restore", A06 |
| MEDIUM | The name/description step never re-verified the sets | The step carries the sets that must remain (also stored for reconcile); any difference is a mismatch and freezes writes | `review-round2b` "metadata step", A07 |
| MEDIUM | "Sync all" could run past the 60 s function limit | Time budget per request (20 s, `H2G_BATCH_BUDGET_MS`); the dashboard continues with the ids already tried | route matrix "time budget", A10 |
| MEDIUM | The documented backup pipeline could produce an "authentic" empty backup | `pipefail` + remove on failure; the tool refuses empty and non-`PGDMP` input, `verify` checks the archive inside | `backup-crypt.test.ts`, A11 |
| MEDIUM | §12a understated token-row writes | Exact conditions documented; the legacy flat shape is no longer rewritten | token-store tests, R5a/R5b |
| MEDIUM | Safeguards without a negative control | New tests for category, null ≠ 0, foreign-activity backup, restore identity, pre-restore backup, final CAS, reconcile re-read, sync intent CAS, restore phase, quarantine; staging evidence aggregated over every request | `review-round2b` "negative controls", proxy/quarantine tests, rehearsal |
| LOW | Absent fields and `exercises: null` unchecked in a restore | `absentMeansNull` for restore read-back | `review-round2b`, A08 |
| LOW | GCM tag/IV length, lenient base64, text-only key reuse, odd row shapes, ticket exchange without key | All fixed as listed in finding 4 | vault tests, A12–A15 |
| LOW | Staging: GET credential route, real-credential variables, guard coverage, Neon role | All methods refused; variables refused at start and per request; an unmarked database must be completely empty; docs require a role that cannot reach production | proxy, quarantine, staging tests; A16, A17, A19 |
| LOW | `H2G_STRICT_STOP` accepted only a few spellings | Fail-closed parsing | A09 |
| LOW | §12a delete trigger broader than stated; stale doc statements | Corrected (rejection statuses incl. a CDN 403; five tables, two unique indexes; vault refuses at use) | docs |
| INFO | Hard stop does not stop authentication | Documented as by design (no activity data) | §2 |
| INFO | Quarantine was build-time only | Runtime quarantine in `instrumentation.ts` and on every request in `proxy.ts` | proxy/quarantine tests, A18, A21 |
| INFO | Own-origin passthrough matched any local URL | Only `GET …/api/session-epoch` | staging test, A20 |
| INFO | The Python token store can overwrite a sealed row | Documented: the Python package must not run against this database | §13 |

## 3. Negative controls

`TEST_DATABASE_URL=… python3 tools/maintenance/strict_mutations.py` breaks
each safeguard on purpose, runs the tests that must notice, and restores the
file. Result on the final candidate: see section 4.

| Group | Controls | Breaks |
| --- | --- | --- |
| R1 hard stop | R1a–R1f | firewall check, engine restore/sync checks, DB freeze blocking restore, dashboard checks |
| R2 exclusivity | R2a–R2g | lock holder, Postgres lease, in-flight index, journal CAS, reconcile/restore locks, conflict handling |
| R3 verification | R3a–R3f | REST sets, missing values, probability, identity, required metrics, tolerance |
| R4 vault/backups | R4a–R4i | CAS, AAD, plaintext use, key separation, plaintext write, rotation, route prechecks, backup header |
| R5 dry run | R5a, R5b | token-row rewrite, rotated tokens lost |
| R6 staging/build | R6a–R6h | transport, guard, proxy, vault, token store, both build gates, firewall transport |
| A re-audit #2 | A01–A21 | every fix of section 2 |

Equivalent mutants (kept on the list, expected to survive): **R1e** (the
dashboard's restore check is redundant to the engine's, which R1b proves).

## 4. Requalification of the final candidate

Filled in with the exact commit and results when the candidate is final.
