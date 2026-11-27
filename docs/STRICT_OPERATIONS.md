# Strict in-place merge — operations and qualification dossier

Status: **development-qualified on synthetic data; deployment quarantine in force.**
Contract: [STRICT_MERGE_MIGRATION.md](STRICT_MERGE_MIGRATION.md). Branch
`migration/strict-inplace-20261127`, draft PR #11. Nothing here authorises a
deployment, a live sync, a package publication or a change to real Garmin or
Hevy data. Each of those needs the owner's separate approval (gates E–G).

## 1. What strict mode guarantees, and where each guarantee is enforced

| Guarantee | Enforced by (outermost first) | Evidence |
| --- | --- | --- |
| No FIT upload, no activity delete, no workout/calendar/gear write | 1. process `fetch` firewall (`typescript/src/strict/firewall.ts`, installed by `web/instrumentation.ts` and before every Garmin client); 2. 423 in `web/proxy.ts`; 3. 423 in each route; 4. library guards (`assertLegacyGarminWrites`); 5. the strict engine's Garmin port has no upload/delete at all | `tests/strict/firewall.test.ts`, `web/app/api/strict-route-matrix.strict.test.ts`, `web/lib/strict-e2e.db.strict.test.ts`, CI "Web against an empty database" (production server: firewall self-test, 423s) |
| Only sets and name/description of ONE activity, only inside a capability scope for that id | firewall classifier + AsyncLocalStorage scope shared process-wide | firewall tests incl. two engine copies in one process |
| One unambiguous native original; defer otherwise | `selectStrictMergeMatch` + reverse match against other Hevy workouts + listing-truncation check + detail re-check | `tests/strict/strict-sync.test.ts` "matching" |
| Exclusive durable binding, atomic claims | `strict_bindings` (both ids UNIQUE), single-statement claim, leases | ledger contract on memory and Postgres |
| One operation per activity, uninterrupted (sync, restore, reconcile) | `strict_activity_locks`; under the lock the binding and the activity are re-read and must equal what was planned from; every write first renews the lock only if held without interruption (fencing); one in-flight journal entry per activity (partial unique index); a writer's release never lifts a review | ledger contract (fencing), `tests/strict/review-round2b.test.ts`, `strict-e2e` (3 concurrent restores → 1 PUT); STRICT_REAUDIT_ROUND2.md |
| Immutable original backup, verified before any write | `strict_backups` insert-only triggers, one `original` per activity, SHA-256 read back before the PUT | contract + DB tests (UPDATE/DELETE/TRUNCATE refused, also after restore) |
| Write-ahead journal; uncertain ⇒ blocked; no blind retry | `put_sent` durable before the request; read-back decides `verified` / `not_applied` / `needs_review` (+ freeze) | strict-sync tests: lost response, timeout, partial read-back, crash after `put_sent`, concurrent runs |
| Native timing, HR and metrics preserved; user notes kept; no estimated HR/kcal in text | payload overlays watch timing when set counts match; 19 native metric paths compared after every write; description block appended between markers | model tests, e2e test |
| Dry run: no Garmin activity write, no sync state, no credential change unless Garmin rotates the tokens | default `dryRun: true`; plan from reads only; Hevy read without key-status bookkeeping; credential reads issue SELECT only; unchanged Garmin tokens are not re-saved. **Not zero-write in every case** — the exact residuals are listed in §12a | e2e dry-run test (every table's rows byte-identical), `credential-vault.db.strict.test.ts` (SELECT-only reads, client build leaves the row identical); re-audit #7, round 2 #5 |
| Stored credentials encrypted at rest | AES-256-GCM envelope per row (`web/lib/credential-vault.ts`), AAD bound to the platform, key id per row, separate key `H2G_CREDENTIALS_KEY`; strict mode refuses to store or use plaintext | `credential-vault.strict.test.ts`, `credential-vault.db.strict.test.ts`, `credential-routes.strict.test.ts`, `db-qualification.db.test.ts` (pg_dump holds no secret) |
| Automatic paths off | `H2G_STRICT_AUTOMATIC=enabled-by-owner` required; otherwise 423 | route matrix, CI production check |
| Legacy pending uploads quarantined | strict engine refuses them; retry/abandon/finalize routes 423; skip only for untouched workouts | strict-sync + matrix tests; re-audit #8 |
| Python CLI cannot write | `refuse_if_strict` at every sync-engine entry point and ledger-changing CLI command, and before every Garmin/intervals.icu write | `tests/test_strict_mode.py`; re-audit #1 |

## 2. Configuration

Strict mode needs **no** variable. Every variable below exists to be set
deliberately, and a missing or misspelled one keeps the safe state.

| Variable | Effect |
| --- | --- |
| *(none)* | strict in-place merge, firewall on, automatic runs locked |
| `H2G_STRICT_AUTOMATIC=enabled-by-owner` | gate G: cron and webhook may run the strict merge |
| `H2G_STRICT_STOP=1` | stop switch at deployment level: every live strict write and every restore refused; a live sync before DB, Hevy or Garmin are touched. Fail-closed: any value except empty/`0`/`false`/`no`/`off` counts as set. It stops Garmin **writes**; sign-in and token refresh (authentication, not activity data) are not writes and are not stopped |
| `H2G_SYNC_MODE=legacy_upstream` **and** `H2G_LEGACY_UPSTREAM_ACK=uploads-and-deletes-allowed` | upstream behaviour (uploads, replace = delete). Both, exactly. Never for this deployment |
| `H2G_DIRECT_GARMIN_LOGIN=1` or `GARMIN_LOGIN_WORKER_URL=<your own Worker>` | how Garmin sign-in runs. With neither, sign-in is refused; credentials are never sent to the shared upstream Worker |
| `H2G_UPDATE_CHECK=off` | recommended: no calls to the GitHub API for the update banner (the banner is hidden in strict mode anyway) |
| `H2G_CREDENTIALS_KEY` | **required in strict mode** to store or use a Garmin token, Hevy key or GitHub token: base64 of 32 random bytes (`openssl rand -base64 32`). Its own secret: equal to `HEVY2GARMIN_SECRET`, `H2G_SECRET`, `CRON_SECRET`, `H2G_PASSWORD` or `H2G_BACKUP_KEY` is refused. One key per environment (staging ≠ production) |
| `H2G_CREDENTIALS_KEYS_PREVIOUS` | comma-separated previous keys, decrypt only, during a rotation (§13) |
| `H2G_BACKUP_KEY` | **not a deployment variable**: lives on the operator's machine / password manager and encrypts database backups (§5) |
| `H2G_STAGING=synthetic` | gate E only: synthetic staging (§7). Hevy and Garmin simulated in-process, no external network, no credential accepted or stored, refuses a database with any real data; refuses to run as a Vercel production deployment or with a real-credential variable set |
| `H2G_PRODUCTION_CUTOVER=approved-by-owner` | gate G: the owner's approved cutover. Without it a Vercel **production** deployment of this candidate refuses every request (runtime quarantine, §4) |
| `H2G_GATE_F=approved-by-owner`, `H2G_GATE_F_HEVY_ID`, `H2G_GATE_F_GARMIN_ACTIVITY_ID`, `H2G_GATE_F_EXPIRES` | gate F only (§8): exactly one Hevy workout into exactly one native Garmin activity, on the owner's own computer, until the expiry (ISO time with zone, at most 14 days ahead). All four or none; anything malformed or contradictory (gate G or automatic flags, plain credentials, synthetic ids, a Vercel runtime) stops the server |
| `H2G_BATCH_BUDGET_MS` | optional, default 20000: a live "Sync all" request starts no new workout after this long; the dashboard calls again for the rest |

## 3. Gates (contract § Gates)

| Gate | State | Evidence / what remains |
| --- | --- | --- |
| A snapshot and quarantine | done | `vercel.json` (both roots) deployment off, `next.config.ts` refuses Vercel builds, no publish path, `typescript/` private with `prepublishOnly` refusal |
| B end-to-end strict mode | done (synthetic) | engine 590 tests, web 964 tests incl. real Postgres, e2e through firewall + Postgres, 61 negative controls (STRICT_REAUDIT_ROUND2.md) |
| C synthetic migration and full CI | done | `web/lib/db-qualification.db.test.ts` (fresh DB, previous fork-main schema, pg_dump/restore); all CI jobs |
| D independent review | done: round 1 9/9 closed (`docs/STRICT_REAUDIT.md`); round 2 owner findings 1–7 and independent re-audit #2 closed (`docs/STRICT_REAUDIT_ROUND2.md`) | no upload/delete path found |
| E isolated staging | **done (synthetic, on Vercel)**: separate project `hevy2garmin-staging` with its own Neon project, protected preview of the final candidate 0a32304, rehearsal 38/38, isolation verified independently, production project unchanged | §7a; the owner may click through the preview (§7 step 5) |
| F one owner-accepted real activity | **ready for the owner**: gate F mode built and qualified (`docs/STRICT_GATE_F.md`); production hardening prepared (§14) | owner steps in `docs/OWNER_RUNBOOK.md`; procedure and design §8 |
| G production activation | **owner** | set `H2G_STRICT_AUTOMATIC` only after F; keep stop switches documented |

## 4. Deployment path (cost-neutral; production still quarantined)

The simplest permanently available setup that costs nothing and uses what
already exists:

| Part | Where | Cost | Notes |
| --- | --- | --- | --- |
| Dashboard + API | **Vercel Hobby**, Root Directory `web`, "Include files outside the Root Directory" on. Two projects: production (`hevy2garmin`, quarantined) and staging (`hevy2garmin-staging`, synthetic previews only, §7a) | free (personal use) | `web/vercel.json` installs and builds the engine first (`installCommand`), automatic Git deployments off, no Vercel crons |
| Database | **Neon free plan**: production = the existing database; staging = a **separate Neon project** (`green-smoke-61642188`), connected only to the staging project, Preview only | free | never a branch of production (it would copy credentials; the staging guard refuses it anyway) |
| Garmin sign-in (production only) | **own Cloudflare Worker** (`GARMIN_LOGIN_WORKER_URL`, Workers free plan) or `H2G_DIRECT_GARMIN_LOGIN=1` | free | credentials never go to the shared upstream Worker; staging needs neither |
| Scheduler (after gate G only) | GitHub Actions `schedule` or a Cloudflare Worker cron trigger calling `/api/cron/sync` with `CRON_SECRET` | free | Vercel Hobby crons are limited, and automatic runs stay off until gate G anyway |
| Backups | operator machine: `pg_dump … \| backup-crypt.mjs encrypt` (§5) | free | before every gate and monthly |

**What Vercel may build and run.** Exactly one thing until the cutover: a
*preview* deployment with `H2G_STAGING=synthetic`. Enforced at build time
twice — `web/scripts/vercel-ignore.mjs` (Ignored Build Step) and
`web/next.config.ts` — and at **runtime** twice, because a build gate can be
bypassed (`vercel build` without `VERCEL_ENV`, then `vercel deploy --prebuilt
--prod`): `web/lib/deploy-quarantine.ts` stops the server at start
(`instrumentation.ts`) and answers 503 to every request (`proxy.ts`) for a
production deployment without `H2G_PRODUCTION_CUTOVER=approved-by-owner` and
for any preview that is not synthetic staging. The quarantine is lifted only
in a separate, reviewed cutover after gate F. Long routes declare
`maxDuration = 60`; a live "Sync all" is split into requests that each start
no new workout after 20 s (`H2G_BATCH_BUDGET_MS`), so the platform never cuts
a write off mid-flight.

**Container (self-hosting alternative).** `docker build -f web/Dockerfile -t
hevy2garmin-web .` from the repository root; the image compiles the engine and
fails unless `verify-engine.mjs` proves it is this commit's build. At start the
log shows `[strict] Garmin network firewall installed`; `GET /api/strict/status`
must report `firewall.installed: true`, `schema.ready: true`,
`automaticEnabled: false`.

## 5. Database

- Additive bootstrap (`web/lib/schema.ts`): six strict tables
  (`strict_bindings`, `strict_backups`, `strict_journal`,
  `strict_activity_locks`, `strict_control`, and `strict_gate_f`, the single
  gate F record, §8), two insert-only triggers on
  `strict_backups`, and two partial unique indexes (one `original` backup per
  activity; one in-flight journal entry per activity). Idempotent; never drops
  or alters an upstream table. Live strict writes are blocked unless
  `strictSchemaReady` confirms the tables, the triggers and both indexes.
- **Backup, encrypted** (from the operator's machine, client tools of the
  **same major version as the server** — CI found that pg_dump 18 output
  cannot be restored into Postgres 16):

  ```bash
  set -o pipefail; F="h2g-$(date +%F).dump.h2gbak"; pg_dump --format=custom --no-owner "$DATABASE_URL" | node web/scripts/backup-crypt.mjs encrypt - "$F" || { rm -f "$F"; echo "BACKUP FAILED"; }
  ```

  AES-256-GCM with `H2G_BACKUP_KEY`; magic and header are authenticated
  (AAD), the 128-bit tag is checked before the output exists. The tool
  refuses an empty input and anything that is not a pg_dump custom archive
  (`PGDMP`; `--raw` for other files); `pipefail` matters because a pg_dump
  that fails part-way still produced a valid-looking prefix. `verify` checks a
  file without writing anything, including that a pg_dump archive is inside;
  `pg_restore --list` on the decrypted file is the final check. Credentials inside the dump are additionally
  sealed with `H2G_CREDENTIALS_KEY`, so a leaked backup needs both keys.
- **Restore** into an empty database:

  ```bash
  node web/scripts/backup-crypt.mjs decrypt h2g.dump.h2gbak h2g.dump && pg_restore --no-owner --exit-on-error --dbname="$TARGET" h2g.dump
  ```

  A wrong key, a changed byte or a truncated file fails and leaves no output;
  delete the decrypted `h2g.dump` after the restore.
  then check `GET /api/strict/status` → `schema.ready` and that
  `DELETE FROM strict_backups` is refused. Qualified on synthetic data, the
  stop switch state survives the round-trip.
- Never delete strict tables: they hold the only copy of the original sets.

## 6. Rollback and stop

- **Stop now**: dashboard "Stop all writes" (or `POST /api/strict/freeze {frozen:true}`);
  if the database is unreachable, set `H2G_STRICT_STOP=1` and restart.
- **Lift** only when no journal entry is open: dashboard "Lift stop…" (typed `UNFREEZE`).
- **Reconcile** ("Check by read-back") is refused while the writer still holds its lease;
  it never writes to Garmin. A mismatch it finds marks the workout for review.
- **Code rollback**: redeploy the previous *strict-qualified* image with the
  stop switch on. Never roll back to an upstream image or set legacy mode: that
  re-enables uploads and deletes. The strict tables are additive; older code
  ignores them, and the migration test proves no legacy column is lost.
- **Undo a verified merge**: open the journal entry → "Restore backup…" →
  choose original or pre-write → type `RESTORE <id>`. One sets PUT and, if
  needed, one name/description PUT, both read back.

## 7. Isolated staging with synthetic data (gate E)

**What it is.** The production build with `H2G_STAGING=synthetic`
(`web/lib/staging-mode.ts`): the real strict engine, ledger, firewall and
dashboard; Hevy and Garmin Connect simulated in-process at the HTTP level
(`web/lib/staging-simulator.ts`), installed as the firewall's transport so
every request meets the production firewall first and nothing leaves the
process. Credential routes answer 423 for every method (a key can travel in a
GET query) before anything is read, the vault refuses every write, staging
refuses to run with any real-credential variable set (`HEVY_API_KEY`,
`GITHUB_PAT`, `GARMIN_*`, `GARMIN_LOGIN_WORKER_URL`, `H2G_CREDENTIALS_KEY`,
`COLLECTOR_*`, `H2G_STRICT_AUTOMATIC`), and the database guard
(`web/lib/staging-guard.ts`) refuses — before even the schema bootstrap — a
database that holds a credential, or, unless it is already marked as staging,
any row at all; a marked staging database may only ever hold synthetic
(`syn-…`) workouts. Its own-origin passthrough is limited to the proxy's
session-epoch read. A banner on every page says it is synthetic.

**Scenarios** (`web/lib/staging-fixtures.ts`, ids `syn-*`, activities 9100001–9100010):
clean merge · read-back mismatch → needs review → restore · lost response →
read-back verifies · lost response + 60 s outage → uncertain → reconcile ·
synthesized timing (plank, set-count mismatch) · two candidates → needs review ·
no recording → waits · rejected write → not applied · legacy upload → audit
duplicate, strict leaves it alone.

**Qualified in CI** (job "Synthetic staging rehearsal (gate E)"): the
production server in staging mode is driven over HTTP by
`web/scripts/staging-rehearsal.mjs` (38 checks), and pointed at a database with
a credential it refuses every query and creates nothing. On Postgres:
`web/lib/staging.db.strict.test.ts` (the process network replaced by a
tripwire that no request reaches).

**On Vercel** (no new resources):

1. Neon: an empty database for staging that the staging connection string
   **cannot** reach production with: ideally a separate Neon project; within
   the same project, a dedicated role that can connect only to the staging
   database (`CREATE ROLE h2g_staging LOGIN PASSWORD …; GRANT CONNECT,
   CREATE ON DATABASE h2g_staging TO h2g_staging; REVOKE CONNECT ON DATABASE
   <production> FROM PUBLIC;` and grant production only to its own role).
   Never the default owner role, never a branch of production.
2. Vercel project (Root Directory `web`): environment variables scoped to
   **Preview**, ideally to the branch `migration/strict-inplace-20261127`:
   `H2G_STAGING=synthetic`, `DATABASE_URL=<staging database>`,
   `H2G_PASSWORD=<staging-only password>`, `HEVY2GARMIN_SECRET=<random>`,
   `CRON_SECRET=<random>`. Make sure no Preview-scoped `POSTGRES_URL` /
   `DATABASE_URL` of production applies to that branch (a branch-specific value
   wins; the guard refuses a production database regardless). Never set Garmin
   or Hevy credentials, `H2G_STRICT_AUTOMATIC` or `GARMIN_LOGIN_WORKER_URL` there.
3. Create a preview deployment of the branch (Git deployments are off, so it is
   created explicitly: dashboard "Redeploy"/CLI `vercel deploy`/API). Keep
   Vercel Deployment Protection on.
4. Run the rehearsal against it:
   `H2G_REHEARSAL_URL=https://<preview> H2G_REHEARSAL_PASSWORD=<staging password> node web/scripts/staging-rehearsal.mjs`
   (add `H2G_REHEARSAL_BYPASS` when Deployment Protection is on). It refuses to
   run unless the target reports itself as synthetic staging.
5. Click through the dashboard: the banner, Preview, Sync now, the strict panel
   (stop, lift, reconcile, restore), the duplicate audit. `GET
   /api/staging/status` shows every simulated request.

## 7a. Gate E as set up and qualified on Vercel (2026-11-27)

Synthetic data only. No real credential was entered or read, nothing reached
Garmin or Hevy, and the production project and its database were not changed.

**Setup** (team `xantic21s-projects`, Hobby plan, no new paid resource):

| Item | State |
| --- | --- |
| Vercel project | `hevy2garmin-staging` (`prj_ZEpBc7oLBgJ2pl619AgyExNypDKa`), separate from production. **No Git repository linked**, so no branch is ever deployed automatically; each preview is created explicitly from a commit. Root Directory `web`, files outside the root included, install/build as `web/vercel.json`, Ignored Build Step `node scripts/vercel-ignore.mjs`, Node 22.x |
| Protection | Vercel Authentication on every deployment (`all_except_custom_domains`; no custom domain). No automation bypass left (the one used for the rehearsal was revoked afterwards) |
| Variables (Preview only; nothing for Production or Development) | `H2G_STAGING=synthetic`, `H2G_UPDATE_CHECK=off`; `H2G_PASSWORD`, `HEVY2GARMIN_SECRET`, `CRON_SECRET` as Sensitive, staging-only random values; the 18 Neon variables of store `store_Q12dNmiooBZRWrIP`, Sensitive. No Garmin/Hevy/GitHub variable, no `H2G_CREDENTIALS_KEY`, no `H2G_STRICT_AUTOMATIC`, nothing from production |
| Database | Neon project `green-smoke-61642188` (free plan, `fra1`) — a separate Neon project, so its roles and connection strings cannot reach the production project `muddy-block-72846077`. Connected to the staging project only, for Preview only |
| Production | `hevy2garmin` (`prj_3avsQM6o1KUXOvgDU2MZYFRKAPS7`) unchanged against the baseline taken before any staging work: `updatedAt` 1795749432375, latest deployment `dpl_3xaUyy9uvxcNnJQPUYHnjeFJibjA` (main 5e36566), the same 22 variable ids and timestamps; its Neon store is still connected to it alone. No deployment of this branch exists there |

**Deployments of the staging project.**

| Deployment | What happened |
| --- | --- |
| `dpl_6boDf6wGSETyLveAmsaRJYeXMoB4` | Vercel creates the *first* deployment of a project without a Git link as **production**, whatever the request says. The Ignored Build Step refused it (`[quarantine] build skipped … VERCEL_ENV=production, H2G_STAGING=unset`): canceled after about a second, nothing built, nothing served. Proof that the build quarantine works on Vercel itself |
| `dpl_BBHBisAVcjvfw8gDCYdD99dN9B3N` | preview of 37c16b1 built before the database was connected; READY, not used |
| `dpl_4JR3unrcMBQjGdngW2VLdFGyKQUr` | preview of 37c16b1 (code = candidate 73e134a) with the database: build log `[quarantine] synthetic staging preview: building`, engine digest `ea30e153…4cbe3c`, "Engine identity verified"; rehearsal 38/38 |
| `dpl_CQ5z44kWf9gLa35rM4RPLLQUVWsp` | **the qualified preview of the final candidate 0a32304** (adds the deny-list fix from the independent audit): target preview, `/api/version` reports commit 0a32304; rehearsal 38/38. Branch alias `hevy2garmin-staging-git-migration-str-9ef2d5-xantic21s-projects.vercel.app` points here |

**Results.**

| Check | Result |
| --- | --- |
| Without Vercel sign-in | `/`, `/api/staging/status`, `/api/session-epoch`, `/api/strict/credentials`, `/api/cron/sync` and `POST /api/staging/seed` all end at Vercel Authentication (302 to the SSO page); the app is never reached. The revoked bypass token also gets 302 |
| Rehearsal (`staging-rehearsal.mjs`, temporary automation bypass, one per run, each revoked right after) | **38/38** on 37c16b1 and again on 0a32304 (same staging database, marker unchanged): credential routes 423 (POST and GET), destructive routes 423, every scenario, outage → uncertain → reconcile without a write, mismatch → freeze → restore, read-only duplicate audit |
| Database was empty and is staging-only | the guard accepted it only because it held no row in any app table, and marked it at the first request (`2026-11-27T21:42:30Z`); 0 credential rows; automatic sync off |
| Network | 90 simulated requests, only to the in-process `api.hevyapp.com` / `connectapi.garmin.com`; 0 to any other host; every write a sets or name/description PUT on a synthetic activity 91000xx |
| Firewall | enforcement self-test passes through the global `fetch`. It reports `outermost: false` on Vercel: Next.js 16 patches the global `fetch` once per process after instrumentation installed the firewall, so the firewall sits inside Next's wrapper (still on every request's path); `ensureStrictFirewall` wraps once more on top before any Garmin client is built. Expected, no action |
| Independent isolation check | separate read-only agent: staging isolated, production unchanged; 15/16 claims confirmed from Vercel's records, the 16th (no bypass left) verified directly. One LOW finding fixed (0a32304), one MEDIUM production-configuration finding left to the owner (below). Details `docs/STRICT_REAUDIT_ROUND2.md` §5 |

**Owner notes.**

- To click through: open the branch alias above, sign in with Vercel, then
  the dashboard asks for the staging `H2G_PASSWORD`. It is stored as
  Sensitive and cannot be read back from Vercel; set a new Preview value in
  the staging project's settings and redeploy if needed.
- A new preview after code changes: create it explicitly from the commit (no
  Git link). Never give the staging project production variables.
- In the production project, `GARMIN_PASSWORD` is stored as type
  "encrypted" (readable in the dashboard; Vercel flags it `readable-secret`),
  unlike its other secrets (Sensitive). Not changed here (production
  untouched); the owner may re-create it as Sensitive. The dashboard never
  reads it (staging only names it, to refuse it).
- **Recommended (production, owner)**: the production project hands
  `HEVY_API_KEY`, `GARMIN_*`, `GITHUB_PAT` and the production database to
  **Preview** builds too, so every branch of main gets a preview with real
  credentials. This branch is kept out only by its root `vercel.json`
  (pinned by a test). Scope those variables to Production only, or turn
  preview deployments off in that project.
- When gate E is no longer needed, delete the staging project and its Neon
  store; nothing else depends on them.

## 8. One owner-accepted real activity (gate F)

**The contract, corrected.** Gate F must write one real activity, but the
deployment quarantine holds until after gate F. Gate F is therefore not a
production deployment and not part of gate G. It is its own, explicit owner
authorization (`web/lib/gate-f.ts`) that lets the qualified candidate merge
exactly one Hevy workout into exactly one native Garmin activity, on the
owner's own computer, and nothing else.

| Question | Answer |
| --- | --- |
| Where it runs | The owner's computer, from the qualified container image of the exact candidate (`docker run`, `localhost:8096`). Never on Vercel: the runtime quarantine refuses a real gate F wherever `VERCEL`/`VERCEL_ENV` is set, and the build quarantine still builds only synthetic staging. On Vercel gate F exists only as a synthetic rehearsal inside staging. Signing in to Garmin from the owner's own connection also needs no Cloudflare Worker (`H2G_DIRECT_GARMIN_LOGIN=1`) |
| Which database | A new, empty Neon database (free plan) used for nothing else. Not the legacy production database, which gate F never touches, and not the staging database. At gate G this database, with the same `H2G_CREDENTIALS_KEY`, becomes the strict deployment's database, so the original backup and the journal of the gate F activity stay with it |
| Authorization | `H2G_GATE_F=approved-by-owner`, `H2G_GATE_F_HEVY_ID`, `H2G_GATE_F_GARMIN_ACTIVITY_ID`, `H2G_GATE_F_EXPIRES` (at most 14 days ahead). `tools/gate-f/prepare-env.sh` writes them, with fresh secrets, into a private `gate-f.env` |
| Refused at start (server answers 503) | an incomplete or malformed authorization; `H2G_PRODUCTION_CUTOVER` or `H2G_STRICT_AUTOMATIC` (gate G); plain credentials in the environment (`HEVY_API_KEY`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`, `GITHUB_PAT`, intervals.icu, collector); `DEMO_MODE`; legacy mode; no dashboard password; no `H2G_CREDENTIALS_KEY`; synthetic ids outside staging, real ids inside it; any Vercel runtime |
| After the expiry | The server stays readable; no new merge; preview, evidence, stop, reconcile and restore of the authorized activity stay available |

**What the mode allows, and where each limit is enforced** (outermost first):

| Limit | Enforced by |
| --- | --- |
| Only the gate F panel can merge | proxy: every sync entry point (`/api/sync*`, `/api/cron/*`) answers 423 for any method, every other mutating route except sign-in, account connection, settings, mappings and the strict operator routes too; the generic sync routes answer 423 themselves; `runStrictSync` refuses any call without exactly the authorized pin |
| Exactly that workout, exactly that activity, manual only | the engine pin (`StrictSyncOptions.pin`): no batch, cron or webhook trigger, no other workout, no resync, checked before any IO; the activity the matcher finds must be the authorized one, else nothing is written |
| Once | `strict_gate_f`, one row, claimed by a single statement: parallel calls get "in progress"; once anything was journaled the row is final ("done") and refuses every later run, also for another workout; a run that journaled nothing (watch activity not there yet, wrong activity) re-arms it. Under it, the existing binding, activity lock and in-flight journal index |
| Deliberate | the run needs the typed confirmation `GATE-F <hevyId> <activityId>` |
| Recovery only for that activity | restore, reconcile and resolve refuse any journal entry outside the authorized pair (engine and dashboard) |
| Everything else unchanged | hard stop (`H2G_STRICT_STOP`, checked again before the claim), the database freeze, the firewall (no upload, no delete), the verified original backup, the write-ahead journal, full read-back, uncertain → reconcile. If the record is taken over during a run, all writes freeze |
| Evidence | `POST /api/strict/gate-f {action:"evidence"}` (GET requests to Garmin only): the verified original backup (before), the journaled intended state, a fresh read of the activity (after), the comparisons (sets against intended, native metrics against before, after a restore sets against the original) and a SHA-256 over the bundle |

**Gate F and gate G stay separate.**

| | Gate F | Gate G |
| --- | --- | --- |
| Owner authorization | the four `H2G_GATE_F*` variables, one workout, ≤ 14 days | `H2G_PRODUCTION_CUTOVER=approved-by-owner`, then `H2G_STRICT_AUTOMATIC=enabled-by-owner` |
| Runtime | owner's computer, container | Vercel production, after a reviewed change that lifts the build quarantine |
| Writes | one workout, typed confirmation | the strict engine for every new workout |
| Mutual exclusion | refuses to run with either gate G variable set | removes the gate F variables |

**Procedure** (the owner's steps, in order, are in `docs/OWNER_RUNBOOK.md`):

1. Production hardening §14, at least steps 1–4 (legacy cron off before the
   gate F workout is recorded, so the legacy app cannot upload it as a FIT).
2. Record a strength workout on the watch and in Hevy; wait until both are synced.
   Note the Hevy workout id and the Garmin activity id.
3. A new Neon database; `bash tools/gate-f/prepare-env.sh`; build and start the
   container (two commands it prints).
4. `http://localhost:8096`: sign in, connect Hevy (the new key) and Garmin
   (direct sign-in, MFA). Credentials are sealed at once.
5. Gate F panel: **Preview** → check the activity id, the set count, the timing
   source and the planned name. Type the confirmation → **Run gate F**. Expect
   `synced`, both journal steps verified, the activity id unchanged.
6. **Evidence** → keep the JSON. On Garmin Connect (web and phone) compare: HR
   graph, calories, training effect, duration unchanged; exercises, reps and
   weights as in Hevy; **exercise names displayed** (read-back verifies the stored
   state; the display is confirmed here — upstream #159/#325).
7. If anything differs: "Stop all writes", then "Restore backup…" → original,
   then Evidence again.
8. Stop the container. Keep `gate-f.env` (its `H2G_CREDENTIALS_KEY` is needed at
   gate G) and the evidence in the password manager. Gate G only after acceptance.

## 9. Security notes

- Session: HMAC-signed cookie, 30-day TTL, "sign out everywhere" epoch; argon2
  password hash supported (`H2G_PASSWORD_HASH`, preferred over plain
  `H2G_PASSWORD`, whose comparison is constant-time but length-revealing).
  Login rate limit per IP (5 failures) and global (50).
- Cron/webhook: bearer `CRON_SECRET`, constant-time everywhere.
- Garmin tokens, the Hevy key and a GitHub token are sealed in
  `platform_credentials` (AES-256-GCM, §13). This protects against a leaked
  database, branch, dump or backup **without** the deployment's environment.
  It does not protect against a compromised deployment (the key and the
  database URL are both there): keep environment access to the owner.
- No third-party telemetry by default: the visit/error collector runs only
  when `COLLECTOR_URL` and `COLLECTOR_TOKEN` are both set.
- No live credentials in CI: every secret there is a synthetic placeholder.

## 10. Dependencies (npm audit / pip-audit, re-run 2026-11-27 on the gate F candidate)

| Package set | Production | All | Note |
| --- | --- | --- | --- |
| `typescript/` engine | 0 | 0 | vitest 5.0.5 |
| `web/` dashboard | 0 | 0 | vitest 4.1.12; soma-style removed (it pulled react-native/metro/image-size) |
| Python (`requirements.txt`) | 0 | — | pip-audit |
| `universal/` Expo app | 7 (4 high) | — | needs an Expo SDK major; not deployed, GET-only, never built or published by CI |

The one open GitHub Dependabot alert (#1, critical: vitest < 3.2.6, the Vitest
UI server can read and execute files) is on **main**, where
`typescript/package.json` still pins `vitest ^2.0.0`. This branch resolves
vitest 5.0.5 (engine) and 4.1.12 (dashboard); the alert closes when the branch
reaches main. It is a test-only dependency that never ships or runs the UI
server in CI.

## 11. Upstream cutover blockers

- **#475** (web never created its schema): fixed upstream by `web/lib/schema.ts`;
  proven by CI "Web against an empty database" (write round-trip, nine tables)
  and here extended to the strict tables and triggers.
- **#473** (auth middleware answered `/api/cron/*` with 401): `/api/cron` is a
  public path in `web/proxy.ts` with its own constant-time bearer check; the
  strict cron route answers 423 without the owner gate (CI-checked).

## 12a. Dry run: exact side effects (review round 2, finding 5)

A dry run ("Preview", `POST /api/sync` without `live`, the candidate list, the
duplicate audit) never writes to a Garmin activity and records no sync state
(bindings, backups, journal, locks, `synced_workouts`, `sync_log`, Hevy key
status). It is **not** free of every side effect:

| Side effect | When | Why it cannot be removed | Data at risk |
| --- | --- | --- | --- |
| Schema bootstrap DDL (`web/lib/schema.ts`) | first query of every process | `CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION strict_backups_refuse_change` (rewrites the same definition in the catalog). On a complete schema no row changes; on an empty or older database the missing tables/columns are created — a migration, so run it deliberately (deploy step) before the first preview | none (additive, idempotent; migration test) |
| Garmin token check | when the Garmin client is built (once per process) | `GET /userprofile-service/socialProfile` (read); on a 401 a `POST diauth.garmin.com` token grant | none (authentication, not activity data) |
| Garmin token row write | (a) Garmin **rotated** the tokens during the run (refresh after a 401); (b) the row's `status` is not `active` (it is set back to `active`, with new ciphertext and `connected_at`). Unchanged tokens on an active row — nested or in the legacy flat shape — are never rewritten | (a) Garmin invalidates the old refresh token; not saving would lose the login. (b) upstream garmin-auth restores the status so a working login is not reported as disconnected | the credential row (sealed) |
| Garmin token row delete | when garmin-auth classifies the answer to its token check as a rejection: an authentication error with status 400, 401, 403 or none (`isTokenRejection`). A 403 can also come from a CDN or bot block rather than from Garmin's token check | upstream garmin-auth behaviour: a rejected token is treated as stale | the credential row; re-login needed |

Closed in round 2: unchanged tokens are no longer re-saved (`EncryptedTokenStore.save`
compares first; previously every client build rewrote the row and
`connected_at`), credential reads never migrate or re-seal (explicit §13
action only), and the flat-row normalisation does not run in strict mode.

## 12. Known limits

- If Garmin normalises a missing weight/reps to 0 (or the reverse), read-back
  reports a mismatch, the write freezes for review and the backup can be
  restored. Fail-closed by design until gate F shows Garmin's behaviour.
- Warm-ups are written as ACTIVE sets (Garmin's set model has no warm-up flag;
  the watch records them too). Cardio distance is not representable in sets
  and is kept in the journal and description only.
- A Garmin listing of 50 activities for the search window is treated as
  possibly truncated and not decided on.
- The Expo app's remaining advisories (§10).

## 13. Credential vault: keys, migration, rotation

**Threat model.** Sealing protects the Garmin DI tokens, the Hevy API key and
a GitHub token against anyone who obtains the database without the
deployment's environment: a shared Neon branch, a leaked connection string, a
dump, a backup. Each row is an AES-256-GCM envelope
`{h2g_enc:"h2g-aesgcm-v1", kid, iv, tag, ct}` with a fresh 96-bit IV and the
AAD `h2g-credentials:v1:<platform>` (a row copied to another platform does not
open). Activity data, the ledger and the original backups are not encrypted
by this key; losing the key costs a Garmin re-login and re-entering the Hevy
key, never workout data.

**First setup / migration of existing plaintext credentials**

1. Generate a key on a trusted machine: `openssl rand -base64 32`. Store it in
   the password manager. Use a different key per environment.
2. Set it as a *sensitive* environment variable `H2G_CREDENTIALS_KEY` of that
   environment only (Vercel: Project → Settings → Environment Variables,
   scope "Production" or "Preview", never "All"). Redeploy.
3. Dashboard → Strict panel → "Stored credentials" shows the state. With
   plaintext rows it reads "*n* not encrypted" and strict mode does not use
   them; press "Encrypt stored credentials…" (typed `ENCRYPT`; the same as
   `POST /api/strict/credentials {"confirm":"ENCRYPT"}`). Each row is a
   compare-and-set, so a concurrent login is never overwritten; a row that
   cannot be opened is reported and left untouched.
4. The line must read "Encrypted". Take a new encrypted backup (§5) and
   delete every older, plaintext backup.

**Rotation** (yearly, or at once if the key may have leaked)

1. New key as `H2G_CREDENTIALS_KEY`, the old one appended to
   `H2G_CREDENTIALS_KEYS_PREVIOUS`; redeploy. Every row still opens; the line
   reads "*n* on old key".
2. "Encrypt stored credentials…" re-seals every row with the new key.
3. When the line reads "Encrypted", remove the old key from
   `H2G_CREDENTIALS_KEYS_PREVIOUS`, redeploy, take a new backup.
4. If the key leaked together with the database, rotation is not enough:
   also sign in to Garmin again (new tokens) and issue a new Hevy API key.

**Failure modes.** No key in strict mode: credentials are neither accepted
(sign-in, Hevy key and ticket routes answer 503 before anything is sent) nor
used. A key that opens no row ("Cannot open"): the previous key is missing
from `H2G_CREDENTIALS_KEYS_PREVIOUS`. A malformed key or one equal to another
secret (compared as text and as decoded key bytes, base64 and base64url
alike, previous keys and `H2G_PASSWORD_HASH` included): every use of the
vault throws rather than guess. Envelopes with a non-96-bit IV or a tag
shorter than 128 bits are refused. Migration seals only the credential
platforms (`hevy`, `garmin`, `garmin_tokens`, `github`); other rows (the Python
package's `auto_sync` settings) stay as they are, and a credential row that is
not an object is reported as unsupported, never replaced.

**Python package.** It is not part of this deployment and must not run
against its database: its token store would overwrite a sealed
`garmin_tokens` row with plaintext. It has no access to the key by design. It recognises the
envelope, never mistakes it for a credential, and falls back to
`HEVY_API_KEY` / `GITHUB_PAT` (`credentials_sealed` in `config.py`). The
Python dashboard is not part of this deployment.

## 14. Production hardening (owner, before gate F)

Read-only findings on the production project `hevy2garmin`
(`prj_3avsQM6o1KUXOvgDU2MZYFRKAPS7`) and main, 2026-11-27. Nothing was changed.

| # | Finding | Consequence |
| --- | --- | --- |
| H1 | main (the legacy Python app) declares a **Vercel Cron**: `GET /api/cron/sync` daily at 08:00 UTC, which runs the legacy one-workout sync (FIT upload). The project has no `CRON_SECRET`. Whether it succeeds today is not visible (Hobby keeps runtime logs for one hour) | it can upload the gate F workout as a second activity, and keeps the legacy upload path alive |
| H2 | All 22 variables target **Production and Preview**: the 18 Neon variables of the production database, `HEVY_API_KEY`, `GARMIN_EMAIL`, `GARMIN_PASSWORD` (stored readable, Vercel flags it `readable-secret`), `GITHUB_PAT` | every preview build gets the production database and real credentials |
| H3 | main's `vercel.json` has no `git.deploymentEnabled: false`, so **every branch pushed to the repository builds a preview** in this project with those credentials (26 previews from 25 branches exist). This branch is excluded only by its own root `vercel.json` (pinned by a test) | until H2 is fixed, push no new branch from main |
| H4 | 40 deployments (14 production, 26 preview), all created by the owner, all behind Vercel Authentication, none from a fork or Dependabot. **Each keeps the variables it was built with**: changing a variable's targets later does not remove them from existing deployments | old previews keep a working production database connection string |
| H5 | `GARMIN_PASSWORD`/`GARMIN_EMAIL` are read only by the legacy app (fallback password login; its setup also stores email and password in `platform_credentials`). The strict dashboard never reads them; gate F refuses to start with them set | not needed for gate F or G; no migration to Sensitive needed, delete them |
| H6 | `GITHUB_PAT` lets the legacy app write `.github/workflows/sync.yml` (repository write). In strict mode the routes that use it are locked | not needed; a write-capable token in 40 deployment snapshots |
| H7 | The legacy setup obtains Garmin tokens through the shared upstream Worker (`hevy2garmin-exchange-di.gkos.workers.dev`), which sees the tokens it issues. The production database may hold them and other credentials in plain text (not inspected: no database access was used) | gate F signs in directly; the old tokens should die with the password change |

**Rotation: required** for `GITHUB_PAT` (revoke) and the **Garmin password**
(stored readable since July, present in 40 deployment snapshots, possibly in
plain text in the production database; changing it also cuts the legacy
app's fallback login). **Recommended** for the Hevy API key (regenerate; the
new key goes only into the sealed gate F vault). The production **Neon
password** needs rotating only if any old deployment is kept (step 4);
otherwise the database stays reachable only from the current production
deployment, which is retired at gate G. No compromise was found; the
rotation follows from secrets having been stored readable and copied into
immutable snapshots.

**Owner steps** (Vercel dashboard, about 15 minutes; each is reversible except
deletions and rotations):

1. **Stop the legacy sync**: project `hevy2garmin` → Settings → Cron Jobs →
   *Disable Cron Jobs*.
2. **Database to Production only**: Storage → `neon-champagne-mountain` →
   Projects → `hevy2garmin` → environments: only *Production* (all 18 variables
   at once).
3. **Credentials**: Settings → Environment Variables: delete `GITHUB_PAT`,
   `GARMIN_EMAIL`, `GARMIN_PASSWORD`; `HEVY_API_KEY` → *Production* only (or
   delete it; the legacy app keeps its own copy in its database). Should you
   ever keep a secret there, re-create it as *Sensitive*, Production only.
4. **Old deployments**: Deployments → select every deployment except the current
   production one (`dpl_3xaUyy9uvxcNnJQPUYHnjeFJibjA`, main 5e36566) → Delete.
   They are legacy builds; strict mode never rolls back to them.
5. **Rotate**: revoke the GitHub token used as `GITHUB_PAT`; change the Garmin
   account password (sign in again on the phone app if asked); regenerate the
   Hevy API key.
6. Tell Claude: it re-checks read-only (cron state, variable targets,
   deployment list, no new preview) and records the result here.

Until step 2–3 are done, do not push any branch other than
`migration/strict-inplace-20261127`.
