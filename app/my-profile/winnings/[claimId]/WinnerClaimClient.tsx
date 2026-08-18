"use client";

import type {
  OwnWinnerClaim,
  WinnerClaimAction,
  WinnerRecipientSource,
} from "@/lib/winnerClaims/service.server";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type PendingAction = {
  requestId: string;
  action: WinnerClaimAction;
  expectedCandidateRevision: string | null;
  acknowledged: boolean;
};

const buttonClass =
  "min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/70 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";

function sourceLabel(source: WinnerRecipientSource) {
  if (source === "profile") return "your current 2FA-protected Profile Wallet";
  if (source === "correction") return "the latest Team-proposed recipient correction";
  return "the original frozen Submission recipient";
}

function formatRemaining(deadlineAt: string | null, nowMs: number) {
  if (!deadlineAt) return null;
  const remaining = Math.max(0, Date.parse(deadlineAt) - nowMs);
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

function messageFor(code: string) {
  switch (code) {
    case "candidate_stale":
      return "The recipient changed after this page was shown. Nothing was confirmed. Review the refreshed full address before trying again.";
    case "state_conflict":
      return "The Claim state changed in another request. The latest state is being loaded.";
    case "recipient_unavailable":
      return "No valid recipient can be confirmed right now. Nothing was locked; please review your Profile Wallet.";
    case "NETWORK_ERROR":
      return "The result could not be confirmed. Retry the same operation identifier safely.";
    default:
      return "The Claim could not be completed. No unconfirmed recipient will be assumed.";
  }
}

export default function WinnerClaimClient({
  claim,
  databaseTime,
}: {
  claim: OwnWinnerClaim;
  databaseTime: string | null;
}) {
  const router = useRouter();
  const serverNow = databaseTime ? Date.parse(databaseTime) : Date.now();
  const [nowMs, setNowMs] = useState(Number.isFinite(serverNow) ? serverNow : Date.now());
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [declineChecked, setDeclineChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const expiryRefreshRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs((value) => value + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const remaining = useMemo(
    () => formatRemaining(claim.deadlineAt, nowMs),
    [claim.deadlineAt, nowMs]
  );

  useEffect(() => {
    if (
      claim.status !== "unclaimed" ||
      !claim.deadlineAt ||
      nowMs < Date.parse(claim.deadlineAt) ||
      expiryRefreshRef.current
    ) {
      return;
    }
    expiryRefreshRef.current = true;
    router.refresh();
  }, [claim.deadlineAt, claim.status, nowMs, router]);

  async function runAction(action: PendingAction) {
    setBusy(true);
    setError(null);
    setPending(action);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/account/winner-claims/${claim.claimId}`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        });
      } catch {
        throw new Error("NETWORK_ERROR");
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.outcome === "string" ? body.outcome : body.error ?? "UNAVAILABLE");
      }
      setPending(null);
      router.refresh();
    } catch (actionError) {
      const code = actionError instanceof Error ? actionError.message : "UNAVAILABLE";
      setError(messageFor(code));
      if (code !== "NETWORK_ERROR") {
        setPending(null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const candidate = claim.candidate;

  return (
    <section className="rounded-2xl border border-white/10 bg-black/55 p-5 sm:p-7" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-white/55">
            Cycle #{claim.cycleNumber ?? claim.cycleId} · Submission #{claim.submissionId}
          </p>
          <h1 className="mt-2 text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            Winner Claim
          </h1>
        </div>
        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm text-white/75">
          {claim.status.replaceAll("_", " ")}
        </span>
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-black/35 p-4 text-sm text-white/75">
        <p><strong className="text-white">Decision:</strong> {claim.payoutChoice === "keep" ? "Keep 100%" : claim.payoutChoice === "donate" ? `Donate 100%${claim.charity ? ` to ${claim.charity}` : ""}` : `Keep ${claim.splitPercent}% / donate ${100 - (claim.splitPercent ?? 0)}%${claim.charity ? ` to ${claim.charity}` : ""}`}</p>
        {remaining ? (
          <p className="mt-2" role="timer"><strong className="text-white">Authoritative time remaining:</strong> {remaining}</p>
        ) : null}
      </div>

      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="mt-5 rounded-lg border border-red-300/25 bg-red-950/30 p-3 text-sm text-red-100 outline-none">
          {error}
        </p>
      ) : null}

      {claim.status === "unclaimed" && candidate ? (
        <>
          <div className="mt-6 rounded-xl border border-orange-300/30 bg-orange-950/15 p-4 sm:p-5">
            <p className="text-sm text-orange-100">Recipient resolved from {sourceLabel(candidate.source)}:</p>
            <code data-winner-claim-recipient tabIndex={0} className="mt-3 block max-w-full select-all overflow-x-auto whitespace-nowrap rounded-lg bg-black/60 px-3 py-3 font-mono text-sm text-white outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-orange-300 [&::-webkit-scrollbar]:hidden">
              {candidate.address}
            </code>
            <p className="mt-3 text-xs leading-relaxed text-white/60">
              CancerCulture validates recipient form, not wallet ownership. Check every character.
            </p>
          </div>

          <div className="mt-6 space-y-4">
            <label className="flex gap-3 text-sm leading-relaxed text-white/85">
              <input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} />
              I checked this complete exact Wallet and confirm it is where my prize should be paid. I understand that the confirmed winner recipient will be shown publicly with my Fame/Shame winner record.
            </label>
            <button type="button" disabled={busy || !confirmChecked} className={`${buttonClass} border-emerald-300/35`} onClick={() => void runAction({ requestId: crypto.randomUUID(), action: "confirm", expectedCandidateRevision: candidate.revision, acknowledged: true })}>
              {busy ? "Working…" : "Confirm wallet and claim prize"}
            </button>
          </div>

          <div className="mt-7 rounded-xl border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-white/70">
            <h2 className="font-semibold text-white">Is this address wrong?</h2>
            <p className="mt-2">
              Add or change your current 2FA-protected Wallet in <Link className="text-orange-300 underline" href="/my-profile#sol-wallet">My Profile</Link> before the deadline, then return and review the newly resolved full address.
            </p>
            <p className="mt-2">If this address is wrong, do not confirm it. Wallet Issue reports must have been sent from the exact Current Cycle Submission before finalization; otherwise add or change your Profile Wallet through 2FA.</p>
          </div>
        </>
      ) : claim.status === "correction_pending" ? (
        <p className="mt-6 rounded-xl border border-yellow-300/25 bg-yellow-950/20 p-4 text-yellow-100">
          Your Wallet correction is pending. Nothing can be confirmed until a new proposal is ready; you will then receive a fresh 24-hour review window.
        </p>
      ) : claim.status === "confirmed" ? (
        <div className="mt-6 rounded-xl border border-emerald-300/25 bg-emerald-950/20 p-4 text-emerald-100">
          <p className="font-semibold">Prize claimed</p>
          <code className="mt-3 block max-w-full select-all overflow-x-auto whitespace-nowrap rounded-lg bg-black/50 px-3 py-3 font-mono text-sm text-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{claim.confirmedRecipient}</code>
          <p className="mt-3 text-sm">This locked recipient is immutable and may now appear with your public winner record.</p>
        </div>
      ) : claim.status === "unclaimed" ? (
        <div className="mt-6 rounded-xl border border-yellow-300/25 bg-yellow-950/20 p-4 text-yellow-100">
          <p className="font-semibold">No valid recipient is available yet.</p>
          <p className="mt-2 text-sm leading-relaxed">
            Nothing can be confirmed in this state. Before the deadline, add a valid current 2FA-protected Wallet in <Link className="underline" href="/my-profile#sol-wallet">My Profile</Link>. Wallet Issue reports are accepted only from an exact Current Cycle Submission before finalization.
          </p>
        </div>
      ) : (
        <p className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-white/70">
          {claim.status === "not_required" ? "Donation — no claim required. No Wallet was resolved or stored for this decision." : claim.status === "declined" ? "You declined this prize. No payout Wallet is exposed." : "The Claim window expired. No payout Wallet is exposed and no automatic redistribution has been activated."}
        </p>
      )}

      {(claim.status === "unclaimed" || claim.status === "correction_pending") ? (
        <div className="mt-8 border-t border-white/10 pt-5">
          <label className="flex gap-3 text-sm leading-relaxed text-red-100">
            <input type="checkbox" checked={declineChecked} onChange={(event) => setDeclineChecked(event.target.checked)} />
            I understand that declining is final and no automatic redistribution rule is active.
          </label>
          <button type="button" disabled={busy || !declineChecked} className={`${buttonClass} mt-4 border-red-300/35 text-red-100`} onClick={() => void runAction({ requestId: crypto.randomUUID(), action: "decline", expectedCandidateRevision: null, acknowledged: true })}>
            Decline prize
          </button>
        </div>
      ) : null}

      {pending ? (
        <div className="mt-5 rounded-lg border border-orange-300/25 bg-orange-950/20 p-3 text-sm text-orange-100">
          <p>The result is not confirmed. Retry uses the same operation identifier and cannot apply twice.</p>
          <button type="button" disabled={busy} className={`${buttonClass} mt-3`} onClick={() => void runAction(pending)}>Retry same operation</button>
        </div>
      ) : null}
    </section>
  );
}
