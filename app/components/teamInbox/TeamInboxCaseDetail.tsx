"use client";

import { useCallback, useEffect, useState } from "react";

type Detail = Record<string, unknown>;

export default function TeamInboxCaseDetail({
  caseId,
  isAdmin,
}: {
  caseId: string;
  isAdmin: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState("Loading case…");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/team-inbox/cases/${caseId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Case unavailable");
    const result = await response.json() as Detail;
    if (result.outcome !== "found" || !result.case || typeof result.case !== "object") {
      throw new Error("Case unavailable");
    }
    setDetail(result);
    setStatus("");
  }, [caseId]);

  useEffect(() => {
    void load().catch(() => setStatus("This case is unavailable or you no longer have access."));
  }, [load]);

  const mutate = async (action: "claim" | "return" | "force_release") => {
    const caseData = detail?.case as Record<string, unknown> | undefined;
    if (!caseData) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/admin/team-inbox/cases/${caseId}/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          action,
          expectedState: caseData.status,
          expectedRowVersion: caseData.rowVersion,
          expectedWorkVersion: caseData.workVersion,
          note: note.trim() || null,
        }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error("Action unavailable");
      setStatus(typeof result.outcome === "string" ? result.outcome.replaceAll("_", " ") : "Updated");
      setNote("");
      await load();
    } catch {
      setStatus("The case changed or this action is not available to you.");
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <p role="status">{status}</p>;
  const caseData = detail.case as Record<string, unknown>;
  const timeline = Array.isArray(detail.timeline) ? detail.timeline as Record<string, unknown>[] : [];
  const caseStatus = typeof caseData.status === "string" ? caseData.status : "";
  const assignedToMe = caseData.assignedToMe === true;
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-black/35 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-white/50">Account</p>
            <h2 className="mt-1 text-2xl font-semibold">{typeof caseData.username === "string" ? caseData.username : "Account"}</h2>
          </div>
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs uppercase tracking-wide">{caseStatus.replaceAll("_", " ")}</span>
        </div>
        {typeof caseData.assigneeDisplayName === "string" ? <p className="mt-4 text-sm text-white/60">Assigned to {caseData.assigneeDisplayName}</p> : null}
        <div className="mt-5 flex flex-wrap gap-3">
          {caseStatus === "open" ? (
            <button disabled={busy} onClick={() => void mutate("claim")} className="min-h-11 cursor-pointer rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black disabled:opacity-50">Claim case</button>
          ) : null}
          {caseStatus === "in_progress" && assignedToMe ? (
            <button disabled={busy} onClick={() => void mutate("return")} className="min-h-11 cursor-pointer rounded-lg border border-white/20 px-4 py-2 disabled:opacity-50">Return to queue</button>
          ) : null}
          {caseStatus === "in_progress" && isAdmin ? (
            <button disabled={busy || note.trim().length < 3} onClick={() => void mutate("force_release")} className="min-h-11 cursor-pointer rounded-lg border border-red-400/50 px-4 py-2 text-red-200 disabled:opacity-50">Admin force release</button>
          ) : null}
        </div>
        {(caseStatus === "in_progress" && (assignedToMe || isAdmin)) ? (
          <div className="mt-4">
            <label htmlFor="case-note" className="text-sm text-white/65">Optional return note; required for Admin force release</label>
            <textarea id="case-note" value={note} onChange={(event) => setNote(event.target.value.slice(0, 1000))} className="mt-2 min-h-24 w-full rounded-lg border border-white/15 bg-black p-3" />
          </div>
        ) : null}
        {status ? <p className="mt-4 text-sm text-white/65" role="status">{status}</p> : null}
      </section>
      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="font-['Permanent_Marker'] text-2xl text-orange-300">Timeline</h2>
        <ol className="mt-4 space-y-3">
          {timeline.map((event) => (
            <li key={String(event.id)} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="font-semibold">{typeof event.eventType === "string" ? event.eventType.replaceAll("_", " ") : "Update"}</p>
              {typeof event.actorDisplayName === "string" ? <p className="mt-1 text-xs text-white/50">{event.actorDisplayName} · {String(event.actorRole ?? "team")}</p> : null}
              {typeof event.note === "string" ? <p className="mt-2 whitespace-pre-wrap text-sm text-white/70">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
