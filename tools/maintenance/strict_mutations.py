"""Negative controls for the strict review round 2 findings (mutation checks).

Each entry breaks one safeguard on purpose, runs the tests that must notice,
and restores the file. A mutation that SURVIVES means a safeguard no test
proves. Synthetic data only; needs TEST_DATABASE_URL (a Postgres it may create
scratch databases on) for the database-backed checks.

    TEST_DATABASE_URL=postgres://... python3 tools/maintenance/strict_mutations.py [prefix ...]

Results: docs/STRICT_REAUDIT_ROUND2.md. R1e is an equivalent mutant (a redundant
dashboard check above the engine's own, which R1b proves).
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV = dict(os.environ)

ENG = ("typescript", ["npx", "vitest", "run", "tests/strict"])


def web(*files, project="strict"):
    return ("web", ["npx", "vitest", "run", "--project", project, *files])


M = [
    # finding 1: hard stop
    (
        "R1a firewall ignores H2G_STRICT_STOP",
        "typescript/src/strict/firewall.ts",
        'if (strictHardStopActive()) return block(input, init, "H2G_STRICT_STOP is set: every Garmin write is refused");',
        "",
        ENG,
    ),
    (
        "R1b engine restore ignores H2G_STRICT_STOP",
        "typescript/src/strict/strict-sync.ts",
        'if (strictHardStopActive()) return refuse("H2G_STRICT_STOP is set: every Garmin write is refused, restores included");',
        "",
        ENG,
    ),
    (
        "R1c engine write path ignores H2G_STRICT_STOP set during the run",
        "typescript/src/strict/strict-sync.ts",
        '  if (strictHardStopActive()) return { status: "blocked", reason: "H2G_STRICT_STOP is set: every Garmin write is refused", journalId: null, sent: false };',
        "",
        ENG,
    ),
    (
        "R1d DB freeze also blocks restore",
        "typescript/src/strict/strict-sync.ts",
        "  const first = await ledger.getJournal(input.journalId);\n  if (!first)",
        '  if ((await ledger.getControl()).frozen) return refuse("frozen");\n  const first = await ledger.getJournal(input.journalId);\n  if (!first)',
        ENG,
    ),
    (
        "R1e web restore ignores H2G_STRICT_STOP (engine and firewall still refuse)",
        "web/lib/strict-sync.ts",
        '  if (strictEnvStop()) {\n    return { status: "refused" as const',
        '  if (false) {\n    return { status: "refused" as const',
        web("lib/strict-e2e.db.strict.test.ts"),
    ),
    (
        "R1f web live sync ignores H2G_STRICT_STOP (engine still blocks the write)",
        "web/lib/strict-sync.ts",
        "  if (!o.dryRun && strictEnvStop()) {",
        "  if (false) {",
        web("lib/staging.db.strict.test.ts"),
    ),
    # finding 2: exclusive recovery
    (
        "R2a memory lock admits every caller",
        "typescript/src/strict/ledger.ts",
        "if (held && held.owner !== owner && Date.parse(held.leaseUntil) > now.getTime()) return { ok: false, heldBy: clone(held) };",
        "",
        ENG,
    ),
    (
        "R2b Postgres lock ignores a live lease",
        "web/lib/strict-ledger-store.ts",
        "WHERE strict_activity_locks.lease_until <= ${now} OR strict_activity_locks.owner = EXCLUDED.owner",
        "WHERE true",
        web(
            "lib/strict-ledger-store.db.test.ts",
            "lib/strict-e2e.db.strict.test.ts",
            project="upstream",
        ),
    ),
    (
        "R2c no in-flight unique index",
        "web/lib/schema.ts",
        "`CREATE UNIQUE INDEX IF NOT EXISTS strict_journal_one_in_flight ON strict_journal (garmin_activity_id)\n     WHERE phase IN ('intent', 'put_sent', 'put_acknowledged', 'uncertain')`,",
        "`SELECT 1`,",
        web("lib/strict-ledger-store.db.test.ts", project="upstream"),
    ),
    (
        "R2d restore sends although intent→put_sent was refused",
        "typescript/src/strict/strict-sync.ts",
        '    if (!(await ledger.advanceJournal(restoreEntry.id, ["intent"], "put_sent"))) {',
        '    if (!(await ledger.advanceJournal(restoreEntry.id, ["intent"], "put_sent")) && false) {',
        ENG,
    ),
    (
        "R2e reconcile takes no activity lock",
        "typescript/src/strict/strict-sync.ts",
        '  if (!lock.ok) {\n    return { status: "refused", reason: `activity is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation`, journalId, writes: 0 };',
        '  if (false) {\n    return { status: "refused", reason: `activity is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation`, journalId, writes: 0 };',
        ENG,
    ),
    (
        "R2f restore takes no activity lock",
        "typescript/src/strict/strict-sync.ts",
        '  if (!lock.ok) return refuse(`activity ${activityId} is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation`);',
        "",
        ENG,
    ),
    (
        "R2g restore ignores an in-flight journal conflict",
        "typescript/src/strict/strict-sync.ts",
        "      if (isJournalConflict(e)) return refuse((e as Error).message, entry.id);\n      throw e;",
        "      throw e;",
        ENG,
    ),
    # finding 3: full verification
    (
        "R3a REST sets not compared",
        "typescript/src/strict/verify.ts",
        '    compareValue(out, i, "setType", x.setType ?? null, y, "setType");',
        '    if (x.setType !== "ACTIVE") continue;\n    compareValue(out, i, "setType", x.setType ?? null, y, "setType");',
        ENG,
    ),
    (
        "R3b a missing value passes",
        "typescript/src/strict/verify.ts",
        "  if (!present || actual === null || !eq(intended, actual)) out.push",
        "  if (present && actual !== null && !eq(intended, actual)) out.push",
        ENG,
    ),
    (
        "R3c probability not compared",
        "typescript/src/strict/verify.ts",
        '      compareValue(out, i, "probability", v(ex[j] ?? {}, "probability"), ey[j] ?? {}, "probability", numEq(0));',
        "",
        ENG,
    ),
    (
        "R3d read-back identity not checked",
        "typescript/src/strict/verify.ts",
        "    if (Number(got) !== opts.activityId) out.push",
        "    if (false) out.push",
        ENG,
    ),
    (
        "R3e required metrics never missing",
        "typescript/src/strict/verify.ts",
        "  return REQUIRED_PRESERVED_METRICS.filter((p) => !(p in have));",
        "  return [];",
        ENG,
    ),
    (
        "R3f duration tolerance 60 s",
        "typescript/src/strict/verify.ts",
        "Object.freeze({ durationS: 0.5, startMs: 1000 })",
        "Object.freeze({ durationS: 60, startMs: 1000 })",
        ENG,
    ),
    # finding 4: sealed credentials and backups
    (
        "R4a migration without compare-and-set",
        "web/lib/credential-vault.ts",
        "      AND (credentials = ${sql.json(previous)}::jsonb OR credentials = ${sql.json(parse(previous))}::jsonb)",
        "",
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R4b AAD not bound to the platform",
        "web/lib/credential-vault.ts",
        'const aad = (platform: string) => Buffer.from(`h2g-credentials:v1:${platform}`, "utf8");',
        'const aad = (_platform: string) => Buffer.from("h2g-credentials:v1", "utf8");',
        web("lib/credential-vault.strict.test.ts", "lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R4c strict mode uses a plaintext credential",
        "web/lib/credential-vault.ts",
        "  if (strictModeActive(env) && Object.keys(value).length) {",
        "  if (false) {",
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R4d key may equal another secret",
        "web/lib/credential-vault.ts",
        '    assertSeparate("H2G_CREDENTIALS_KEY", currentRaw, key, env);',
        "",
        web("lib/credential-vault.strict.test.ts"),
    ),
    (
        "R4e plaintext stored without a key",
        "web/lib/credential-vault.ts",
        '  else if (encryptionRequired(env)) throw new CredentialVaultError("H2G_CREDENTIALS_KEY is not set; refusing to store a credential in plaintext");',
        "",
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R4f rotation skipped",
        "web/lib/credential-vault.ts",
        "        if (v.kid === ring.current.kid) {",
        "        if (true) {",
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R4g sign-in proceeds without a key",
        "web/app/api/garmin-login/route.ts",
        "    assertVaultWritable();",
        "    void 0;",
        web("app/api/credential-routes.strict.test.ts"),
    ),
    (
        "R4h Hevy key probed without a key",
        "web/app/api/connect-hevy/route.ts",
        "    assertVaultWritable();",
        "    void 0;",
        web("app/api/credential-routes.strict.test.ts"),
    ),
    (
        "R4i backup header not authenticated",
        "web/scripts/backup-crypt.mjs",
        "  decipher.setAAD(Buffer.concat([MAGIC, headerBuf]));",
        "  decipher.setAAD(MAGIC);",
        ("web", ["npx", "vitest", "run", "scripts/backup-crypt.test.ts"]),
    ),
    # finding 5: dry-run side effects
    (
        "R5a unchanged tokens rewritten on every client build",
        "web/lib/encrypted-token-store.ts",
        'rows[0].status === "active" && unchanged(current)) return;',
        'rows[0].status === "active" && false) return;',
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "R5b rotated tokens not saved",
        "web/lib/encrypted-token-store.ts",
        'rows[0].status === "active" && unchanged(current)) return;',
        'rows[0].status === "active" && true) return;',
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    # finding 6: staging
    (
        "R6a staging transport never installed",
        "web/lib/staging-simulator.ts",
        "  if (!stagingMode()) return false;",
        "  return false;",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "R6b staging guard accepts credentials",
        "web/lib/staging-guard.ts",
        "  if (credentials > 0) {",
        "  if (false) {",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "R6c proxy lets credentials into staging",
        "web/proxy.ts",
        '  if (stagingMode() && stagingCredentialPath(pathname, req.method)) return stagingRefusal("Connecting an account");',
        "",
        ("web", ["npx", "vitest", "run", "proxy.test.ts"]),
    ),
    (
        "R6d vault stores credentials in staging",
        "web/lib/credential-vault.ts",
        '  if (stagingMode(env)) throw new CredentialVaultError("synthetic staging never stores a credential");',
        "",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "R6e staging reads the real token store",
        "web/lib/garmin-upload.ts",
        "  if (stagingMode()) return stagingGarminClient();",
        "",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "R6f ignored build step lets production build",
        "web/scripts/vercel-ignore.mjs",
        'if (env === "preview" && staging) {',
        "if (staging) {",
        ("web", ["npx", "vitest", "run", "deploy-quarantine.test.ts"]),
    ),
    (
        "R6g next.config lets production build",
        "web/next.config.ts",
        'process.env.VERCEL_ENV === "preview" && process.env.H2G_STAGING === "synthetic"',
        'process.env.H2G_STAGING === "synthetic"',
        ("web", ["npx", "vitest", "run", "deploy-quarantine.test.ts"]),
    ),
    (
        "R6h firewall forwards to the network despite a transport",
        "typescript/src/strict/firewall.ts",
        '      case "auth":\n        return (shared.transport ?? base)(input, init);',
        '      case "auth":\n        return base(input, init);',
        ENG,
    ),
    # re-audit #2 (closing round): each fix broken on purpose
    (
        "A01 no re-check of the activity under the lock",
        "typescript/src/strict/strict-sync.ts",
        "  if (!unchanged) {",
        "  if (false) {",
        ENG,
    ),
    (
        "A02 no re-check of the binding under the lock",
        "typescript/src/strict/strict-sync.ts",
        '  if (!bindingNow || bindingNow.leaseOwner !== owner || bindingNow.state === "needs_review") {',
        "  if (!bindingNow) {",
        ENG,
    ),
    (
        "A03 lease fencing always passes",
        "typescript/src/strict/strict-sync.ts",
        "    (await ledger.renewActivityLock({ activityId, owner, acquiredAt, now: clock(), leaseMs }))\n      ? null",
        "    true\n      ? null",
        ENG,
    ),
    (
        "A04 an expired lease is revived",
        "typescript/src/strict/ledger.ts",
        "held.acquiredAt !== acquiredAt || Date.parse(held.leaseUntil) <= now.getTime()) return false;",
        "held.acquiredAt !== acquiredAt) return false;",
        ENG,
    ),
    (
        "A05 a writer's release lifts a review",
        "typescript/src/strict/ledger.ts",
        '      if (b.state === "needs_review" && p.state !== undefined) delete p.state;',
        "",
        ENG,
    ),
    (
        "A06 reconcile treats a restore like a sync",
        "typescript/src/strict/strict-sync.ts",
        '  if (entry.step === "restore") {',
        "  if (false) {",
        ENG,
    ),
    (
        "A07 metadata step does not re-check the sets",
        "typescript/src/strict/strict-sync.ts",
        "  const guard = spec.expectSets != null ? compareSetSequences(spec.expectSets, readSets, { activityId: spec.activityId }) : [];",
        "  const guard: ReturnType<typeof compareSetSequences> = [];",
        ENG,
    ),
    (
        "A08 restore leaves absent fields unchecked",
        "typescript/src/strict/verify.ts",
        "(o[k] === undefined && opts.absentMeansNull ? null : o[k])",
        "(o[k])",
        ENG,
    ),
    (
        "A09 hard stop parses permissively again",
        "typescript/src/strict/firewall.ts",
        '  return v !== "" && !/^(0|false|no|off)$/i.test(v);',
        "  return /^(1|true|yes|on)$/i.test(v);",
        ENG,
    ),
    (
        "A10 batch ignores its time budget",
        "web/lib/strict-routes.ts",
        "      if (Date.now() - started > budgetMs) {",
        "      if (false) {",
        web("app/api/strict-route-matrix.strict.test.ts"),
    ),
    (
        "A11 backup accepts an empty input",
        "web/scripts/backup-crypt.mjs",
        "      if (seen === 0) return cb(new BackupError(`${what} is empty`));",
        "",
        ("web", ["npx", "vitest", "run", "scripts/backup-crypt.test.ts"]),
    ),
    (
        "A12 vault accepts a shortened GCM tag",
        "web/lib/credential-vault.ts",
        '    if (iv.length !== 12 || tag.length !== 16) throw new Error("malformed envelope");\n    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });',
        '    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: tag.length });',
        web("lib/credential-vault.strict.test.ts"),
    ),
    (
        "A13 key reuse compared as text only",
        "web/lib/credential-vault.ts",
        "      if (value === raw || (decoded && decoded.equals(key))) {",
        "      if (value === raw) {",
        web("lib/credential-vault.strict.test.ts"),
    ),
    (
        "A14 migration seals non-credential rows",
        "web/lib/credential-vault.ts",
        "  // Only credential rows; anything else in the table (Python's auto_sync settings) is not a secret and stays as it is.\n  const rows = all.filter((row) => CREDENTIAL_PLATFORMS.includes(row.platform));",
        "  const rows = all;",
        web("lib/credential-vault.db.strict.test.ts"),
    ),
    (
        "A15 ticket exchange without the vault precheck",
        "web/app/api/garmin-ticket-exchange/route.ts",
        "    assertVaultWritable();",
        "    void 0;",
        web("app/api/credential-routes.strict.test.ts"),
    ),
    (
        "A16 staging lets credential GETs through",
        "web/lib/staging-mode.ts",
        '  if (method.toUpperCase() === "GET" && /^\\/api\\/strict\\/credentials\\/?$/.test(pathname)) return false;',
        '  if (method.toUpperCase() === "GET") return false;',
        ("web", ["npx", "vitest", "run", "proxy.test.ts"]),
    ),
    (
        "A17 staging ignores real-credential variables",
        "web/lib/deploy-quarantine.ts",
        '    const present = STAGING_FORBIDDEN_ENV.filter((k) => (env[k] ?? "").trim() !== "");',
        "    const present: string[] = [];",
        ("web", ["npx", "vitest", "run", "proxy.test.ts", "deploy-quarantine.test.ts"]),
    ),
    (
        "A18 production runs without the cutover",
        "web/lib/deploy-quarantine.ts",
        '  if (vercelEnv === "production") {',
        "  if (false) {",
        ("web", ["npx", "vitest", "run", "proxy.test.ts", "deploy-quarantine.test.ts"]),
    ),
    (
        "A19 staging guard accepts an unmarked database with rows",
        "web/lib/staging-guard.ts",
        "    for (const t of USER_TABLES) rows += await count(client, t);",
        "",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "A20 staging passes any own-origin URL to the network",
        "web/lib/staging-simulator.ts",
        '    if (ownHost(host) && effective === "GET" && /\\/api\\/session-epoch\\/?$/.test(url.pathname)) return network(input, init);',
        "    if (ownHost(host)) return network(input, init);",
        web("lib/staging.db.strict.test.ts"),
    ),
    (
        "A21 server starts despite the quarantine",
        "web/instrumentation.ts",
        "  if (violation) throw new Error(`[quarantine] ${violation}`);",
        "",
        ("web", ["npx", "vitest", "run", "deploy-quarantine.test.ts"]),
    ),
]


def main() -> int:
    if not ENV.get("TEST_DATABASE_URL"):
        print("TEST_DATABASE_URL is required", file=sys.stderr)
        return 2
    only = sys.argv[1:]
    out = []
    for name, f, old, new, (d, cmd) in M:
        if only and not any(name.startswith(o) for o in only):
            continue
        p = os.path.join(ROOT, f)
        with open(p, encoding="utf-8") as fh:
            src = fh.read()
        if src.count(old) != 1:
            out.append((name, "TARGET NOT FOUND", ""))
            print(name, "TARGET NOT FOUND", flush=True)
            continue
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(src.replace(old, new))
        try:
            if f.startswith("typescript/") and d == "web":
                subprocess.run(
                    ["npm", "run", "build"],
                    cwd=os.path.join(ROOT, "typescript"),
                    capture_output=True,
                    check=False,
                )
            r = subprocess.run(
                cmd,
                cwd=os.path.join(ROOT, d),
                capture_output=True,
                text=True,
                env=ENV,
                timeout=900,
                check=False,
            )
            txt = r.stdout + r.stderr
            m = re.search(r"Tests\s+(.*)", txt)
            verdict = "CAUGHT" if r.returncode != 0 else "SURVIVED"
            detail = m.group(1).strip() if m else txt[-200:]
            out.append((name, verdict, detail))
            print(name, "->", verdict, "|", detail, flush=True)
        finally:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(src)

    print(json.dumps({"caught": sum(1 for o in out if o[1] == "CAUGHT"), "total": len(out)}))
    return 0 if all(o[1] == "CAUGHT" or o[0].startswith("R1e") for o in out) else 1


if __name__ == "__main__":
    sys.exit(main())
