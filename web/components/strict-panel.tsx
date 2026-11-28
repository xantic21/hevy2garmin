"use client";

/**
 * Strict in-place mode, at a glance and under control.
 *
 * Shows what protects the user's Garmin data right now (firewall, ledger
 * schema, stop switches, automatic gate), every write whose outcome is not yet
 * verified, and the bindings that need a person. Every action goes through the
 * signed-in /api/strict/* routes; the two that can change Garmin (restore) or
 * re-enable writes (lift the stop) need an explicit typed confirmation.
 */
import { useCallback, useState } from "react";
import { withBasePath } from "@/lib/base-path";

export interface StrictStatusView {
  mode: "strict_inplace";
  automaticEnabled: boolean;
  envStop?: boolean;
  firewall: { installed: boolean; blocked: number; recent: Array<{ at: string; reason: string; method: string; path: string }> };
  schema: { ready: boolean; missing: string[] };
  writeBlock: { blocked: boolean; reason: string | null };
  control: { frozen: boolean; reason: string | null; updatedAt: string | null };
  openJournal: Array<{ id: string; hevyId: string; activityId: number; step: string; phase: string; updatedAt: string }>;
  bindings: Record<string, number>;
  reviewBindings: Array<{ hevyId: string; activityId: number; state: string; lastError: string | null }>;
  credentials?: { configured: boolean; currentKid: string | null; rows: number; encryptedCurrent: number; encryptedPrevious: number; plaintext: number; unreadable: string[] };
}

interface AuditReport {
  window: { start: string; end: string };
  summary: Record<string, number>;
  cleanupCandidates: Array<{ activityId: number; keepActivityId: number; hevyId: string; reason: string }>;
  findings: Array<{ kind: string; severity: string; evidence: string; recommendation: string; activityIds: number[] }>;
  truncatedDays: string[];
  reportSha256: string;
  deleted: 0;
}

const PHASE_LABEL: Record<string, string> = {
  intent: "Recorded, not sent",
  put_sent: "Sent, outcome unknown",
  put_acknowledged: "Accepted, not yet verified",
  uncertain: "Uncertain",
  needs_review: "Needs review",
};

async function post(path: string, body: unknown) {
  const res = await fetch(withBasePath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) throw new Error(String(data.error ?? `Request failed (${res.status})`));
  return data;
}

function Fact({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" | "neutral" }) {
  const toneClass =
    tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : tone === "bad" ? "text-danger" : "text-text-secondary";
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-base/70 px-4 py-3">
      <span className="t-eyebrow">{label}</span>
      <span className={`text-sm font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

export function StrictPanel({ initial }: { initial: StrictStatusView | null }) {
  const [status, setStatus] = useState<StrictStatusView | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(withBasePath("/api/strict/status"), { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { status?: StrictStatusView };
    if (data.status) setStatus(data.status);
  }, []);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: await fn() });
      await refresh();
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const reconcile = (id: string) =>
    act(`reconcile-${id}`, async () => {
      const d = await post("/api/strict/reconcile", { journalId: id });
      const r = d.result as { status: string; reason: string | null };
      return `Journal ${id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}. Read-back only; nothing was written to Garmin.`;
    });

  const restore = (id: string) => {
    const source = window.confirm("Restore the ORIGINAL watch sets (everything strict mode ever wrote is undone)?\n\nOK = original · Cancel = the state just before this write")
      ? "original"
      : "pre_write";
    const typed = window.prompt(`This writes the verified ${source === "original" ? "original" : "pre-write"} backup back to Garmin and reads it back.\nType RESTORE ${id} to confirm.`);
    if (typed !== `RESTORE ${id}`) return;
    void act(`restore-${id}`, async () => {
      const d = await post("/api/strict/restore", { journalId: id, source, confirm: typed });
      const r = d.result as { status: string; reason: string | null };
      return `Restore of journal ${id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}.`;
    });
  };

  const resolve = (id: string) => {
    const note = window.prompt("What did you check, and what is the activity's state now? (kept in the journal)");
    if (!note?.trim()) return;
    void act(`resolve-${id}`, async () => {
      const d = await post("/api/strict/resolve", { journalId: id, note });
      return d.resolved ? `Journal ${id} closed.` : `Journal ${id} was not closed (${String(d.reason ?? "not in review")}).`;
    });
  };

  const stop = () =>
    act("stop", async () => {
      await post("/api/strict/freeze", { frozen: true, reason: "stopped from the dashboard" });
      return "All strict writes are stopped.";
    });

  const lift = () => {
    const typed = window.prompt("Lift the stop switch? Live merges become possible again. Type UNFREEZE to confirm.");
    if (typed !== "UNFREEZE") return;
    void act("lift", async () => {
      const d = await post("/api/strict/freeze", { frozen: false, confirm: typed });
      return d.frozen === false ? "Stop lifted." : `Still stopped: ${String(d.reason ?? "")}`;
    });
  };

  const encrypt = () => {
    const typed = window.prompt("Encrypt every stored credential with the current key (and re-encrypt those under an old key)? Type ENCRYPT to confirm.");
    if (typed !== "ENCRYPT") return;
    void act("encrypt", async () => {
      const d = await post("/api/strict/credentials", { confirm: typed });
      const r = d.result as { encrypted: string[]; rotated: string[]; failed: string[] };
      const done = r.encrypted.length + r.rotated.length;
      return r.failed.length
        ? `Encrypted ${done}; ${r.failed.length} could not be changed (${r.failed.join(", ")}). Check the keys and try again.`
        : `Encrypted ${done} stored credential${done === 1 ? "" : "s"}. Take a new encrypted backup and delete older plaintext ones.`;
    });
  };

  const runAudit = () =>
    act("audit", async () => {
      const res = await fetch(withBasePath("/api/strict/duplicate-audit?days=90"), { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; report?: AuditReport; error?: string };
      if (!res.ok || !d.report) throw new Error(d.error ?? `Audit failed (${res.status})`);
      setAudit(d.report);
      return `Audit finished: ${d.report.findings.length} finding(s), ${d.report.cleanupCandidates.length} cleanup candidate(s). Nothing was deleted.`;
    });

  if (!status) {
    return (
      <section aria-labelledby="strict-heading" className="oui-card mb-6">
        <h2 id="strict-heading" className="t-title text-text">Strict in-place merge</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Status is unavailable without a database. Nothing can be written to Garmin until it is.
        </p>
      </section>
    );
  }

  const stopped = status.control.frozen || Boolean(status.envStop);
  const vault = describeVault(status.credentials);
  const open = status.openJournal;
  const verified = status.bindings.verified ?? 0;
  const review = (status.bindings.needs_review ?? 0) + (status.bindings.claimed ?? 0);

  return (
    <section aria-labelledby="strict-heading" className="oui-card mb-6 flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="t-eyebrow">Protection</span>
          <h2 id="strict-heading" className="t-headline mt-1 text-text">Strict in-place merge</h2>
          <p className="mt-1 max-w-[62ch] text-sm text-text-secondary">
            Hevy sets are written into the one activity your watch recorded, with a verified backup first and a full
            read-back after. Nothing is uploaded and nothing is deleted.
          </p>
        </div>
        <span
          role="status"
          className={`oui-pill ${stopped ? "bg-[#fdecea] text-danger" : status.writeBlock.blocked ? "bg-warm-bg text-warning" : "bg-teal-bg text-teal"}`}
        >
          {stopped ? "Writes stopped" : status.writeBlock.blocked ? "Writes blocked" : "Ready"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Network firewall" value={status.firewall.installed ? `On · ${status.firewall.blocked} blocked` : "Not installed"} tone={status.firewall.installed ? "ok" : "bad"} />
        <Fact label="Ledger" value={status.schema.ready ? "Verified" : "Incomplete"} tone={status.schema.ready ? "ok" : "bad"} />
        <Fact label="Automatic sync" value={status.automaticEnabled ? "Owner-enabled" : "Off until approved"} tone={status.automaticEnabled ? "warn" : "neutral"} />
        <Fact label="Merged & verified" value={String(verified)} tone="neutral" />
        <Fact label="Stored credentials" value={vault.label} tone={vault.tone} />
      </div>

      {(status.writeBlock.blocked || status.envStop || !status.schema.ready || vault.problem) && (
        <div className="rounded-2xl border border-warm-dim/60 bg-warm-bg px-4 py-3 text-sm text-text">
          {status.envStop && <p><strong>H2G_STRICT_STOP</strong> is set for this deployment: live writes are off.</p>}
          {status.writeBlock.reason && <p>{status.writeBlock.reason}</p>}
          {!status.schema.ready && <p>Ledger schema incomplete: {status.schema.missing.join(", ")}.</p>}
          {vault.problem && <p>{vault.problem}</p>}
        </div>
      )}

      {open.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="t-title text-text">Writes waiting for verification</h3>
          <ul className="oui-group">
            {open.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">
                    Journal {e.id} · {PHASE_LABEL[e.phase] ?? e.phase}
                  </p>
                  <p className="t-caption text-text-muted">
                    {e.step === "exercise_sets" ? "Sets" : e.step === "metadata" ? "Name and description" : "Restore"} · activity{" "}
                    <a className="text-teal underline" href={`https://connect.garmin.com/modern/activity/${e.activityId}`} target="_blank" rel="noreferrer">
                      {e.activityId}
                    </a>{" "}
                    · workout {e.hevyId}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {e.phase !== "needs_review" && (
                    <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={() => void reconcile(e.id)}>
                      Check by read-back
                    </button>
                  )}
                  {e.phase === "needs_review" && (
                    <>
                      <button type="button" className="oui-button oui-button-danger" disabled={busy !== null} onClick={() => restore(e.id)}>
                        Restore backup…
                      </button>
                      <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={() => resolve(e.id)}>
                        Mark reviewed…
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {review > 0 && status.reviewBindings.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="t-title text-text">Workouts that need a person</h3>
          <ul className="oui-group">
            {status.reviewBindings.map((b) => (
              <li key={b.hevyId} className="px-4 py-3">
                <p className="text-sm font-semibold text-text">
                  Workout {b.hevyId} → activity {b.activityId} · {b.state === "claimed" ? "unfinished" : "needs review"}
                </p>
                {b.lastError && <p className="t-caption mt-0.5 text-text-muted">{b.lastError}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {status.control.frozen ? (
          <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={lift}>
            Lift stop…
          </button>
        ) : (
          <button type="button" className="oui-button oui-button-danger" disabled={busy !== null} onClick={() => void stop()}>
            Stop all writes
          </button>
        )}
        {status.credentials?.configured && (status.credentials.plaintext > 0 || status.credentials.encryptedPrevious > 0) && (
          <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={encrypt}>
            {busy === "encrypt" ? "Encrypting…" : "Encrypt stored credentials…"}
          </button>
        )}
        <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={() => void runAudit()}>
          {busy === "audit" ? "Auditing…" : "Audit duplicates (read-only)"}
        </button>
      </div>

      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-danger" : "text-success"}`}>
          {message.text}
        </p>
      )}

      {audit && (
        <div className="flex flex-col gap-2">
          <h3 className="t-title text-text">
            Duplicate audit · {audit.window.start} – {audit.window.end}
          </h3>
          <p className="t-caption text-text-muted">
            Read-only. Deleted: {audit.deleted}. Report {audit.reportSha256.slice(0, 12)}… — cite it when approving any cleanup.
            {audit.truncatedDays.length > 0 && ` Possibly truncated days: ${audit.truncatedDays.join(", ")}.`}
          </p>
          {audit.findings.length === 0 ? (
            <p className="text-sm text-success">No duplicates or ledger conflicts found.</p>
          ) : (
            <ul className="oui-group">
              {audit.findings.map((f, i) => (
                <li key={i} className="px-4 py-3">
                  <p className="text-sm font-semibold text-text">
                    {f.severity === "duplicate" ? "Duplicate" : f.severity === "conflict" ? "Conflict" : "Note"} · {f.kind.replace(/_/g, " ")}
                  </p>
                  <p className="t-caption mt-0.5 text-text-secondary">{f.evidence}</p>
                  <p className="t-caption mt-0.5 text-text-muted">{f.recommendation}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** One line for the credential vault: sealed with the current key is the only "ok". Counts only, never a value. */
export function describeVault(c: StrictStatusView["credentials"]): { label: string; tone: "ok" | "warn" | "bad" | "neutral"; problem: string | null } {
  if (!c) return { label: "Unknown", tone: "neutral", problem: null };
  if (c.unreadable.length) return { label: "Cannot open", tone: "bad", problem: `Stored credentials cannot be opened with the configured keys (${c.unreadable.join(", ")}). Add the old key to H2G_CREDENTIALS_KEYS_PREVIOUS.` };
  if (!c.configured) return { label: c.plaintext ? "Not encrypted" : "No key set", tone: "bad", problem: "H2G_CREDENTIALS_KEY is not set: credentials cannot be stored or used in strict mode." };
  if (c.plaintext) return { label: `${c.plaintext} not encrypted`, tone: "bad", problem: `${c.plaintext} stored credential${c.plaintext === 1 ? " is" : "s are"} still plaintext. Encrypt them ("Encrypt stored credentials…" below). Strict mode does not use them until then.` };
  if (c.encryptedPrevious) return { label: `${c.encryptedPrevious} on old key`, tone: "warn", problem: `${c.encryptedPrevious} credential${c.encryptedPrevious === 1 ? " is" : "s are"} sealed with a previous key. Re-encrypt before removing it.` };
  return { label: c.rows ? "Encrypted" : "None stored", tone: "ok", problem: null };
}
