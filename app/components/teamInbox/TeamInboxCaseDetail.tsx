"use client";

import CopyReportedWalletButton from "@/app/components/teamInbox/CopyReportedWalletButton";
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

  const resolveWalletIssue = async (resolution: "accept_correction" | "no_action") => {
    const caseData = detail?.case as Record<string, unknown> | undefined;
    const walletIssue = detail?.walletIssue as Record<string, unknown> | undefined;
    const intake = walletIssue?.intake as Record<string, unknown> | undefined;
    const claim = walletIssue?.claim as Record<string, unknown> | undefined;
    if (!caseData || !walletIssue || !intake || !claim) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/admin/team-inbox/cases/${caseId}/wallet-issue/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          resolution,
          expectedCaseRowVersion: caseData.rowVersion,
          expectedCaseWorkVersion: caseData.workVersion,
          expectedSourceVersion: walletIssue.caseSourceVersion,
          expectedIntakeVersion: intake.version,
          expectedClaimVersion: claim.version,
          note: note.trim() || null,
        }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok || result.outcome !== "resolved") {
        throw new Error(String(result.error ?? result.outcome ?? "unavailable"));
      }
      setStatus("Resolved. The winner now has a fresh 24-hour confirmation window.");
      setNote("");
      await load();
    } catch (error) {
      setStatus(error instanceof Error && error.message === "candidate_mismatch"
        ? "No action is only valid when the current recipient already exactly matches the reported recipient."
        : error instanceof Error && error.message === "WINNER_PROFILE_WALLET_OWNER_CONTROLLED"
          ? "The active 2FA Profile Wallet is authoritative and must be changed by the winner personally."
        : "The case changed or the resolution is no longer available.");
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <p role="status">{status}</p>;
  const caseData = detail.case as Record<string, unknown>;
  const timeline = Array.isArray(detail.timeline) ? detail.timeline as Record<string, unknown>[] : [];
  const caseStatus = typeof caseData.status === "string" ? caseData.status : "";
  const assignedToMe = caseData.assignedToMe === true;
  const walletIssue = detail.walletIssue && typeof detail.walletIssue === "object"
    ? detail.walletIssue as Record<string, unknown>
    : null;
  const walletIntake = walletIssue?.intake && typeof walletIssue.intake === "object"
    ? walletIssue.intake as Record<string, unknown>
    : null;
  const currentCandidate = walletIssue?.currentCandidate && typeof walletIssue.currentCandidate === "object"
    ? walletIssue.currentCandidate as Record<string, unknown>
    : null;
  const currentCandidateMatches = currentCandidate?.address === walletIntake?.desiredRecipient;
  const profileWalletControlsCandidate = currentCandidate?.source === "profile";
  const reportedRecipient = typeof walletIntake?.desiredRecipient === "string"
    ? walletIntake.desiredRecipient
    : "";
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
      {walletIntake ? (
        <section className="rounded-2xl border border-orange-300/25 bg-orange-500/5 p-6" aria-labelledby="wallet-issue-title">
          <h2 id="wallet-issue-title" className="font-['Permanent_Marker'] text-2xl text-orange-300">Wallet Issue details</h2>
          <p className="mt-4 text-sm text-white/55">Submission #{String(walletIntake.submissionId ?? "-")}</p>
          <p className="mt-3 whitespace-pre-wrap text-sm text-white/80">{String(walletIntake.description ?? "")}</p>
          <p className="mt-4 text-xs uppercase tracking-wide text-white/50">New Wallet reported by the user</p>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start">
            <code className="block min-w-0 flex-1 overflow-x-auto rounded bg-black/50 p-3 text-sm">{reportedRecipient}</code>
            {reportedRecipient ? <CopyReportedWalletButton walletAddress={reportedRecipient} /> : null}
          </div>
          <p className="mt-4 text-xs uppercase tracking-wide text-white/50">Current candidate</p>
          {currentCandidate ? (
            <>
              <code className="mt-1 block overflow-x-auto rounded bg-black/50 p-3 text-sm">{String(currentCandidate.address ?? "")}</code>
              <p className="mt-1 text-xs text-white/45">Source: {String(currentCandidate.source ?? "-")}</p>
            </>
          ) : <p className="mt-1 text-sm text-red-200">No valid current candidate.</p>}
          {walletIntake.screenshotAvailable === true ? (
            <a href={`/api/admin/team-inbox/wallet-issues/intakes/${String(walletIntake.intakeId)}/screenshot`} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-11 items-center text-sm text-orange-200 underline">View private screenshot</a>
          ) : null}
          {caseStatus === "in_progress" && assignedToMe && walletIntake.status === "promoted" ? (
            <div className="mt-5 flex flex-wrap gap-3">
              {!profileWalletControlsCandidate ? <button disabled={busy || currentCandidateMatches} onClick={() => void resolveWalletIssue("accept_correction")} className="min-h-11 rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black disabled:opacity-40">Accept reported Wallet & notify winner</button> : null}
              <button disabled={busy || !currentCandidateMatches} onClick={() => void resolveWalletIssue("no_action")} className="min-h-11 rounded-lg border border-white/20 px-4 py-2 disabled:opacity-40">No action — already matches</button>
            </div>
          ) : null}
          {profileWalletControlsCandidate ? (
            <p className="mt-3 text-sm text-yellow-200">The winner&apos;s active 2FA Profile Wallet is authoritative. Team correction is unavailable; only the winner can change it personally.{!currentCandidateMatches ? " Recheck this case after the winner updates the Wallet." : " The case can be closed as already matching."}</p>
          ) : null}
          <p className="mt-3 text-xs text-white/50">Team resolution never confirms the Claim. The winner must review the full recipient and confirm it personally.</p>
        </section>
      ) : null}
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
