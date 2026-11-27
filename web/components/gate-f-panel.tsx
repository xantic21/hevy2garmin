"use client";

/**
 * Gate F: the one owner-authorized real activity.
 *
 * Shows exactly what is authorized and the state of every safeguard, then
 * offers three steps: a dry-run preview of that pair, the one live merge
 * (typed confirmation naming both ids), and the evidence bundle (before,
 * intended, after) to download. Recovery (stop, reconcile, restore) stays in
 * the strict panel below and is limited to the authorized activity.
 */
import { useCallback, useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";

interface GateFStatusView {
  gateF: boolean;
  reason?: string;
  authorization?: { hevyId: string; activityId: number; expiresAt: string; synthetic: boolean; expired: boolean };
  confirmation?: string;
  record?: { state: string; attempts: number; startedAt: string | null; finishedAt: string | null; lastResult: { status?: string; reason?: string | null } | null } | null;
  safeguards?: {
    envStop: boolean;
    writeBlock: { blocked: boolean; reason: string | null };
    schema: { ready: boolean; gateFTable: boolean };
    firewall: { installed: boolean };
    credentials: { configured: boolean; plaintext: number; rows: number };
  };
  binding?: { state: string } | null;
  originalBackup?: { sha256: string; intact: boolean } | null;
}

async function call(body: unknown) {
  const res = await fetch(withBasePath("/api/strict/gate-f"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) throw new Error(String(data.error ?? `Request failed (${res.status})`));
  return data;
}

function Row({ label, value, good }: { label: string; value: string; good: boolean | null }) {
  const tone = good === null ? "text-text-secondary" : good ? "text-success" : "text-danger";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-base/70 px-4 py-2">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{value}</span>
    </div>
  );
}

export function GateFPanel() {
  const [s, setS] = useState<GateFStatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [typed, setTyped] = useState("");
  // The plan the preview showed; the run is bound to it and refused if anything changed since.
  const [plan, setPlan] = useState<{ sha256: string; summary: string } | null>(null);

  const load = useCallback(
    () =>
      fetch(withBasePath("/api/strict/gate-f"), { cache: "no-store" })
        .then((res) => res.json())
        .catch(() => ({ gateF: false, reason: "gate F status unavailable" })) as Promise<GateFStatusView>,
    [],
  );
  const refresh = useCallback(async () => setS(await load()), [load]);

  useEffect(() => {
    let alive = true;
    load().then((d) => {
      if (alive) setS(d);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: await fn() });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  if (!s) return null;
  if (!s.gateF || !s.authorization || !s.safeguards) {
    return (
      <section className="oui-card mb-6 flex flex-col gap-4">
        <h2 className="t-title text-text">Gate F</h2>
        <p className="mt-2 text-sm text-danger">{s.reason ?? "Gate F is not available."}</p>
      </section>
    );
  }
  const a = s.authorization;
  const g = s.safeguards;
  const done = s.record?.state === "done";
  const ready = !a.expired && !done && !g.envStop && !g.writeBlock.blocked && g.schema.ready && g.schema.gateFTable && g.firewall.installed;

  const preview = () =>
    act("preview", async () => {
      const d = await call({ action: "preview" });
      if (d.refused) return `Refused: ${String(d.refused)}`;
      const r = d.result as {
        status: string;
        reason: string | null;
        activityId: number | null;
        plan: { activeSets: number; timingSource: string; rename: string | null; descriptionChange: boolean; planSha256: string } | null;
      };
      if (!r.plan || r.status !== "dry_run") {
        setPlan(null);
        return `Preview: ${r.status}${r.reason ? ` (${r.reason})` : ""}. Nothing was written.`;
      }
      const summary = `activity ${r.activityId}, ${r.plan.activeSets} sets (${r.plan.timingSource} timing)${r.plan.rename ? `, name "${r.plan.rename}"` : ""}${r.plan.descriptionChange ? ", description updated" : ""}`;
      setPlan({ sha256: r.plan.planSha256, summary });
      return `Preview: ${summary}. Plan ${r.plan.planSha256.slice(0, 12)}…. Nothing was written.`;
    });

  const run = () =>
    act("run", async () => {
      const d = await call({ action: "run", confirm: typed, planSha256: plan?.sha256 });
      setTyped("");
      setPlan(null);
      if (d.refused) return `Refused: ${String(d.refused)}`;
      const r = d.result as { status: string; reason: string | null; writes: number };
      const warning = d.warning ? ` WARNING: ${String(d.warning)}` : "";
      return `Gate F run: ${r.status}${r.reason ? ` (${r.reason})` : ""}; ${r.writes} Garmin write(s). Download the evidence next.${warning}`;
    });

  const evidence = () =>
    act("evidence", async () => {
      const d = await call({ action: "evidence" });
      if (d.refused) return `Refused: ${String(d.refused)}`;
      const blob = new Blob([JSON.stringify({ bundle: d.bundle, bundleSha256: d.bundleSha256 }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `gate-f-evidence-${a.activityId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const v = (d.bundle as { verdict?: { expected: string; ok: boolean; checks: Record<string, string> } }).verdict;
      const failed = v ? Object.entries(v.checks).filter(([, c]) => c !== "passed").map(([k, c]) => `${k}: ${c}`) : [];
      return `Evidence downloaded (SHA-256 ${String(d.bundleSha256).slice(0, 16)}…): ${v?.ok ? `verdict OK (${v.expected})` : `verdict NOT OK (${v?.expected ?? "?"}${failed.length ? `; ${failed.join(", ")}` : ""})`}. Nothing was written.`;
    });

  return (
    <section className="oui-card mb-6 flex flex-col gap-4" aria-label="Gate F">
      <h2 className="t-title text-text">Gate F · one authorized activity{a.synthetic ? " (synthetic rehearsal)" : ""}</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Only Hevy workout <code>{a.hevyId}</code> into Garmin activity <code>{a.activityId}</code>, strict in-place merge only. Every other sync is locked.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Row label="Authorization" value={a.expired ? `expired ${a.expiresAt}` : `valid until ${a.expiresAt}`} good={!a.expired} />
        <Row label="Run" value={done ? `done (${s.record?.lastResult?.status ?? "?"})` : s.record ? `${s.record.state}, ${s.record.attempts} attempt(s)` : "not yet run"} good={null} />
        <Row label="Hard stop (H2G_STRICT_STOP)" value={g.envStop ? "on: every write refused" : "off"} good={!g.envStop} />
        <Row label="Write block" value={g.writeBlock.blocked ? (g.writeBlock.reason ?? "blocked") : "none"} good={!g.writeBlock.blocked} />
        <Row label="Firewall self-test" value={g.firewall.installed ? "passes" : "FAILS"} good={g.firewall.installed} />
        <Row label="Ledger schema" value={g.schema.ready && g.schema.gateFTable ? "ready" : "incomplete"} good={g.schema.ready && g.schema.gateFTable} />
        <Row label="Credentials" value={g.credentials.plaintext ? `${g.credentials.plaintext} not sealed` : `${g.credentials.rows} sealed`} good={g.credentials.plaintext === 0} />
        <Row label="Original backup" value={s.originalBackup ? (s.originalBackup.intact ? "verified" : "CORRUPT") : "not yet taken"} good={s.originalBackup ? s.originalBackup.intact : null} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={preview}>
          {busy === "preview" ? "Previewing…" : "1 · Preview (dry run)"}
        </button>
        <input
          className="min-w-[16rem] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none"
          placeholder={`Type: ${s.confirmation}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={!ready || busy !== null}
          aria-label="Gate F confirmation"
        />
        <button type="button" className="oui-button oui-button-primary" disabled={!ready || busy !== null || !plan || typed !== s.confirmation} onClick={run}>
          {busy === "run" ? "Merging…" : "2 · Run gate F"}
        </button>
        <button type="button" className="oui-button oui-button-tonal" disabled={busy !== null} onClick={evidence}>
          {busy === "evidence" ? "Reading…" : "3 · Evidence"}
        </button>
      </div>
      {plan && <p className="text-sm text-text-secondary">The run is bound to this preview: {plan.summary}. Anything that changes the plan before you run refuses the run.</p>}
      {message && <p className={`text-sm ${message.kind === "ok" ? "text-text" : "text-danger"}`}>{message.text}</p>}
    </section>
  );
}
