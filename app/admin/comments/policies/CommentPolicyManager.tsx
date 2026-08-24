"use client";

import { useState } from "react";
import type {
  CommunityCommentPolicyManagement,
  CommunityCommentReleaseState,
} from "@/lib/comments/commentPolicyManagement.server";

const inputClassName = "w-full rounded border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-300";
const buttonClassName = "cursor-pointer rounded bg-orange-600 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-orange-500 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";
const dangerButtonClassName = "cursor-pointer rounded border border-red-400/40 bg-red-950/40 px-4 py-2 text-sm font-semibold text-red-100 outline-none hover:bg-red-900/50 focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50";

type RequestStatus = Readonly<{ kind: "idle" | "saving" | "success" | "error"; message: string }>;

async function postPolicy(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/comments/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "The save failed.");
  return payload;
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function Status({ value }: { value: RequestStatus }) {
  if (value.kind === "idle") return null;
  return (
    <p className={`text-sm ${value.kind === "error" ? "text-red-300" : "text-emerald-300"}`} role="status">
      {value.message}
    </p>
  );
}

function ActionPolicyCard({
  item,
}: {
  item: CommunityCommentPolicyManagement["actions"][number];
}) {
  const policy = item.activePolicy;
  const [windowSeconds, setWindowSeconds] = useState(policy?.windowSeconds.toString() ?? "");
  const [maxActions, setMaxActions] = useState(policy?.maxActions.toString() ?? "");
  const [cooldownSeconds, setCooldownSeconds] = useState(policy?.cooldownSeconds.toString() ?? "");
  const [turnstileAfter, setTurnstileAfter] = useState(policy?.turnstileAfter.toString() ?? "");
  const [status, setStatus] = useState<RequestStatus>({ kind: "idle", message: "" });

  async function save(active: boolean) {
    setStatus({ kind: "saving", message: "Saving…" });
    try {
      await postPolicy({
        operation: "abuse_policy",
        action: item.action,
        expectedStateVersion: item.stateVersion,
        active,
        windowSeconds: active ? numberOrNull(windowSeconds) : null,
        maxActions: active ? numberOrNull(maxActions) : null,
        cooldownSeconds: active ? numberOrNull(cooldownSeconds) : null,
        turnstileAfter: active ? numberOrNull(turnstileAfter) : null,
        requestId: crypto.randomUUID(),
      });
      setStatus({ kind: "success", message: active ? "New policy version activated." : "Policy disabled." });
      window.location.reload();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "The save failed." });
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.04] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold capitalize">{item.action}</h3>
          <p className="mt-1 text-xs text-white/50">
            State version {item.stateVersion} · {policy ? `active policy v${policy.policyVersion}` : "disabled"}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${policy ? "bg-emerald-500/15 text-emerald-200" : "bg-white/10 text-white/60"}`}>
          {policy ? "Active" : "Off"}
        </span>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <NumberField label="Window (seconds)" value={windowSeconds} onChange={setWindowSeconds} />
        <NumberField label="Maximum actions" value={maxActions} onChange={setMaxActions} />
        <NumberField label="Cooldown (seconds)" value={cooldownSeconds} onChange={setCooldownSeconds} />
        <NumberField label="Turnstile after" value={turnstileAfter} onChange={setTurnstileAfter} min={0} />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className={buttonClassName} type="button" disabled={status.kind === "saving"} onClick={() => save(true)}>
          Activate new version
        </button>
        {policy ? (
          <button className={dangerButtonClassName} type="button" disabled={status.kind === "saving"} onClick={() => save(false)}>
            Disable
          </button>
        ) : null}
        <Status value={status} />
      </div>
    </section>
  );
}

function NumberField({ label, value, onChange, min = 1 }: { label: string; value: string; onChange: (value: string) => void; min?: number }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-white/70">{label}</span>
      <input className={inputClassName} type="number" min={min} step={1} value={value} onChange={(event) => onChange(event.target.value)} required />
    </label>
  );
}

function SpamPolicyCard({ spam }: { spam: CommunityCommentPolicyManagement["spam"] }) {
  const policy = spam.activePolicy;
  const [minimumEventCount, setMinimumEventCount] = useState(policy?.minimumEventCount.toString() ?? "");
  const [lookbackSeconds, setLookbackSeconds] = useState(policy?.lookbackSeconds.toString() ?? "");
  const [thresholdScore, setThresholdScore] = useState(policy?.thresholdScore.toString() ?? "");
  const [weights, setWeights] = useState(policy ? JSON.stringify(policy.signalWeights, null, 2) : "{}");
  const [status, setStatus] = useState<RequestStatus>({ kind: "idle", message: "" });

  async function save(active: boolean) {
    setStatus({ kind: "saving", message: "Saving…" });
    try {
      let signalWeights: Record<string, unknown> | null = null;
      if (active) {
        const parsed = JSON.parse(weights) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Signal weights must be a JSON object.");
        signalWeights = parsed as Record<string, unknown>;
      }
      await postPolicy({
        operation: "spam_policy",
        expectedStateVersion: spam.stateVersion,
        active,
        minimumEventCount: active ? numberOrNull(minimumEventCount) : null,
        lookbackSeconds: active ? numberOrNull(lookbackSeconds) : null,
        thresholdScore: active ? numberOrNull(thresholdScore) : null,
        signalWeights,
        requestId: crypto.randomUUID(),
      });
      setStatus({ kind: "success", message: active ? "New Spam Review policy activated." : "Spam Review policy disabled." });
      window.location.reload();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "The save failed." });
    }
  }

  return (
    <section className="rounded-xl border border-orange-500/25 bg-white/[0.04] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Spam Review policy</h2>
          <p className="mt-1 text-xs text-white/50">
            State version {spam.stateVersion} · {policy ? `active policy v${policy.policyVersion}` : "disabled"}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${policy ? "bg-emerald-500/15 text-emerald-200" : "bg-white/10 text-white/60"}`}>
          {policy ? "Active" : "Off"}
        </span>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <NumberField label="Minimum events" value={minimumEventCount} onChange={setMinimumEventCount} />
        <NumberField label="Lookback (seconds)" value={lookbackSeconds} onChange={setLookbackSeconds} />
        <NumberField label="Score threshold" value={thresholdScore} onChange={setThresholdScore} />
      </div>
      <label className="mt-4 block space-y-1 text-sm">
        <span className="text-white/70">Private signal weights (JSON)</span>
        <textarea className={`${inputClassName} min-h-44 font-mono text-xs`} value={weights} onChange={(event) => setWeights(event.target.value)} spellCheck={false} />
      </label>
      <p className="mt-2 text-xs leading-5 text-white/45">
        Keys combine an action with a rejected outcome. Values remain private operational configuration and every calibration creates a new immutable version.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className={buttonClassName} type="button" disabled={status.kind === "saving"} onClick={() => save(true)}>
          Activate new version
        </button>
        {policy ? (
          <button className={dangerButtonClassName} type="button" disabled={status.kind === "saving"} onClick={() => save(false)}>
            Disable
          </button>
        ) : null}
        <Status value={status} />
      </div>
    </section>
  );
}

export default function CommentPolicyManager({ initialState }: { initialState: CommunityCommentPolicyManagement }) {
  const [releaseStatus, setReleaseStatus] = useState<RequestStatus>({ kind: "idle", message: "" });

  async function setReleaseState(state: CommunityCommentReleaseState) {
    setReleaseStatus({ kind: "saving", message: "Saving…" });
    try {
      await postPolicy({
        operation: "release_state",
        releaseState: state,
        expectedVersion: initialState.release.version,
        requestId: crypto.randomUUID(),
      });
      setReleaseStatus({ kind: "success", message: `Comment release state changed to ${state}.` });
      window.location.reload();
    } catch (error) {
      setReleaseStatus({ kind: "error", message: error instanceof Error ? error.message : "The save failed." });
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-orange-500/30 bg-orange-950/10 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Global release state</h2>
            <p className="mt-1 text-sm text-white/55">Current: <strong className="text-white">{initialState.release.state}</strong> · version {initialState.release.version}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["off", "read_only", "open"] as const).map((state) => (
              <button key={state} className={state === "off" ? dangerButtonClassName : buttonClassName} type="button" disabled={releaseStatus.kind === "saving" || state === initialState.release.state} onClick={() => setReleaseState(state)}>
                {state}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4"><Status value={releaseStatus} /></div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Action budgets</h2>
          <p className="mt-1 text-sm leading-6 text-white/55">
            Root, Reply, Edit, Vote and Report use independent user-scoped buckets. Disabling a policy makes that mutation fail closed.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {initialState.actions.map((item) => <ActionPolicyCard key={item.action} item={item} />)}
        </div>
      </section>

      <SpamPolicyCard spam={initialState.spam} />
      <p className="rounded-lg border border-white/10 bg-black/20 p-4 text-xs leading-5 text-white/45">
        These controls never ban, shadowban, remove, hide or rank content automatically. Spam Review creates human-review context only.
      </p>
    </div>
  );
}
