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
| `H2G_STRICT_STOP=1` | stop switch at deployment level: every live strict write refused before DB, Hevy or Garmin are touched |
| `H2G_SYNC_MODE=legacy_upstream` **and** `H2G_LEGACY_UPSTREAM_ACK=uploads-and-deletes-allowed` | upstream behaviour (uploads, replace = delete). Both, exactly. Never for this deployment |
| `H2G_DIRECT_GARMIN_LOGIN=1` or `GARMIN_LOGIN_WORKER_URL=<your own Worker>` | how Garmin sign-in runs. With neither, sign-in is refused; credentials are never sent to the shared upstream Worker |
| `H2G_UPDATE_CHECK=off` | recommended: no calls to the GitHub API for the update banner (the banner is hidden in strict mode anyway) |
| `H2G_CREDENTIALS_KEY` | **required in strict mode** to store or use a Garmin token, Hevy key or GitHub token: base64 of 32 random bytes (`openssl rand -base64 32`). Its own secret: equal to `HEVY2GARMIN_SECRET`, `H2G_SECRET`, `CRON_SECRET`, `H2G_PASSWORD` or `H2G_BACKUP_KEY` is refused. One key per environment (staging ≠ production) |
| `H2G_CREDENTIALS_KEYS_PREVIOUS` | comma-separated previous keys, decrypt only, during a rotation (§13) |
| `H2G_BACKUP_KEY` | **not a deployment variable**: lives on the operator's machine / password manager and encrypts database backups (§5) |
| `H2G_STAGING=synthetic` | gate E only: synthetic staging (§7). Hevy and Garmin simulated in-process, no external network, no credential accepted or stored, refuses a database with real data; refuses to start as a Vercel production deployment |

## 3. Gates (contract § Gates)

| Gate | State | Evidence / what remains |
| --- | --- | --- |
| A snapshot and quarantine | done | `vercel.json` (both roots) deployment off, `next.config.ts` refuses Vercel builds, no publish path, `typescript/` private with `prepublishOnly` refusal |
| B end-to-end strict mode | done (synthetic) | engine 533 tests, web 802 tests + real-Postgres cases, e2e through firewall + Postgres |
| C synthetic migration and full CI | done | `web/lib/db-qualification.db.test.ts` (fresh DB, previous fork-main schema, pg_dump/restore); all CI jobs |
| D independent review | done, 9/9 findings closed | `docs/STRICT_REAUDIT.md`; no upload/delete path found |
| E isolated staging | prepared (conditional GO): synthetic staging mode, CI rehearsal, Vercel preview path | §7; the owner opens the preview and runs the rehearsal |
| F one owner-accepted real activity | **owner** | procedure §8 |
| G production activation | **owner** | set `H2G_STRICT_AUTOMATIC` only after F; keep stop switches documented |

## 4. Deployment path (cost-neutral; production still quarantined)

The simplest permanently available setup that costs nothing and uses what
already exists:

| Part | Where | Cost | Notes |
| --- | --- | --- | --- |
| Dashboard + API | **Vercel Hobby**, one project, Root Directory `web`, "Include files outside the Root Directory" on | free (personal use) | `web/vercel.json` installs and builds the engine first (`installCommand`), automatic Git deployments off, no Vercel crons |
| Database | **Neon free plan**: production = the existing database; staging = a **separate, empty** database (e.g. `h2g_staging` in the same project) | free | never a branch of production (it would copy credentials; the staging guard refuses it anyway) |
| Garmin sign-in (production only) | **own Cloudflare Worker** (`GARMIN_LOGIN_WORKER_URL`, Workers free plan) or `H2G_DIRECT_GARMIN_LOGIN=1` | free | credentials never go to the shared upstream Worker; staging needs neither |
| Scheduler (after gate G only) | GitHub Actions `schedule` or a Cloudflare Worker cron trigger calling `/api/cron/sync` with `CRON_SECRET` | free | Vercel Hobby crons are limited, and automatic runs stay off until gate G anyway |
| Backups | operator machine: `pg_dump … \| backup-crypt.mjs encrypt` (§5) | free | before every gate and monthly |

**What Vercel may build.** Exactly one thing until the cutover: a *preview*
deployment with `H2G_STAGING=synthetic`. Enforced twice:
`web/scripts/vercel-ignore.mjs` (Ignored Build Step: anything else is skipped)
and `web/next.config.ts` (anything else fails the build). Production builds stay
refused; the quarantine is lifted only in a separate, reviewed cutover after
gate F. Long routes declare `maxDuration = 60` (within every plan).

**Container (self-hosting alternative).** `docker build -f web/Dockerfile -t
hevy2garmin-web .` from the repository root; the image compiles the engine and
fails unless `verify-engine.mjs` proves it is this commit's build. At start the
log shows `[strict] Garmin network firewall installed`; `GET /api/strict/status`
must report `firewall.installed: true`, `schema.ready: true`,
`automaticEnabled: false`.

## 5. Database

- Additive bootstrap (`web/lib/schema.ts`): four strict tables, two
  insert-only triggers, one partial unique index. Idempotent; never drops or
  alters an upstream table. Live strict writes are blocked unless
  `strictSchemaReady` confirms tables, triggers and index.
- **Backup, encrypted** (from the operator's machine, client tools of the
  **same major version as the server** — CI found that pg_dump 18 output
  cannot be restored into Postgres 16):

  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" | node web/scripts/backup-crypt.mjs encrypt - "h2g-$(date +%F).dump.h2gbak"
  ```

  AES-256-GCM with `H2G_BACKUP_KEY`; magic and header are authenticated
  (AAD), the tag is checked before the output exists. `verify` checks a file
  without writing anything. Credentials inside the dump are additionally
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
process. Credential routes answer 423 before reading the body, the vault
refuses every write, and the database guard (`web/lib/staging-guard.ts`)
refuses — before even the schema bootstrap — any database holding a
credential or non-synthetic history. A banner on every page says it is
synthetic.

**Scenarios** (`web/lib/staging-fixtures.ts`, ids `syn-*`, activities 9100001–9100010):
clean merge · read-back mismatch → needs review → restore · lost response →
read-back verifies · lost response + 60 s outage → uncertain → reconcile ·
synthesized timing (plank, set-count mismatch) · two candidates → needs review ·
no recording → waits · rejected write → not applied · legacy upload → audit
duplicate, strict leaves it alone.

**Qualified in CI** (job "Synthetic staging rehearsal (gate E)"): the
production server in staging mode is driven over HTTP by
`web/scripts/staging-rehearsal.mjs` (37 checks), and pointed at a database with
a credential it refuses every query and creates nothing. On Postgres:
`web/lib/staging.db.strict.test.ts` (the process network replaced by a
tripwire that no request reaches).

**On Vercel** (no new resources):

1. Neon: create an empty database for staging (or any other free, empty
   Postgres). Not a branch of production.
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

## 8. One owner-accepted real activity (gate F, owner)

1. Record a strength workout on the watch and in Hevy; wait until both are synced.
2. `pg_dump` the database (§5).
3. Dashboard → "Preview" for that workout: confirm the activity id, set count,
   timing source and the planned name/description.
4. "Sync now" once. Expect `synced`; the journal shows `exercise_sets:verified`
   and `metadata:verified`; the activity id is unchanged.
5. Compare on Garmin Connect (web and phone) before/after: HR graph, calories,
   training effect, duration unchanged; exercises, reps and weights as in Hevy;
   **exercise names displayed** (read-back verifies stored state only; display
   is confirmed here — upstream #159/#325).
6. If anything differs: "Stop all writes", then "Restore backup…" → original.
7. Only after acceptance: gate G.

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

## 10. Dependencies (npm audit / pip-audit, 2026-11-27)

| Package set | Production | All | Note |
| --- | --- | --- | --- |
| `typescript/` engine | 0 | 0 | |
| `web/` dashboard | 0 | 0 | soma-style removed (it pulled react-native/metro/image-size) |
| Python (`requirements.txt`) | 0 | — | pip-audit |
| `universal/` Expo app | 7 (4 high) | — | needs an Expo SDK major; not deployed, GET-only, never built or published by CI |

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
| Garmin token row write | only if Garmin **rotated** the tokens during the run (refresh after a 401) | Garmin invalidates the old refresh token; not saving would lose the login | the credential row (sealed) |
| Garmin token row delete | only if Garmin **rejected** the tokens | upstream garmin-auth behaviour: a rejected token is stale | the credential row; re-login needed |

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
secret: the vault refuses to start rather than guess.

**Python package.** It has no access to the key by design. It recognises the
envelope, never mistakes it for a credential, and falls back to
`HEVY_API_KEY` / `GITHUB_PAT` (`credentials_sealed` in `config.py`). The
Python dashboard is not part of this deployment.
