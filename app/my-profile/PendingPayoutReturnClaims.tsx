"use client";

import { useState } from "react";
import ClaimCountdown from "@/app/components/winners/ClaimCountdown";
import { formatLamportsAsSol } from "@/lib/payouts/amount";
import type { OwnPayoutReturnClaim } from "@/lib/payouts/service.server";

export default function PendingPayoutReturnClaims({ items, databaseTime }: { items: OwnPayoutReturnClaim[] | null; databaseTime: string | null }) {
  const pending = items?.filter((item) => item.status === "unclaimed") ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (pending.length === 0) return null;
  async function act(claim: OwnPayoutReturnClaim, action: "confirm" | "decline", formData: FormData) {
    setBusy(claim.claimPublicId); setError(null);
    try {
      const response = await fetch(`/api/account/payout-return-claims/${claim.claimPublicId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: claim.rowVersion, action, manualRecipient: String(formData.get("manual_recipient") ?? "").trim() || null }) });
      if (!response.ok) throw new Error("The return claim could not be updated.");
      location.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The return claim could not be updated."); setBusy(null); }
  }
  return <section className="rounded-2xl border border-orange-300/35 bg-orange-950/20 p-5 sm:p-6">
    <h2 className="text-2xl font-[Permanent_Marker] text-[var(--orange-dark)]">Donation return claim</h2>
    <p className="mt-2 text-sm text-white/65">A binding Community Vote returned an unavailable donation to you. Team cannot enter your wallet.</p>
    {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
    <div className="mt-4 space-y-4">{pending.map((claim) => <form key={claim.claimPublicId} action={(data) => act(claim, "confirm", data)} className="rounded-xl border border-white/10 bg-black/35 p-4">
      <strong>Cycle #{claim.cycleNumber ?? claim.cycleId} · Submission #{claim.submissionId} · {formatLamportsAsSol(claim.amountLamports)} SOL</strong>
      {claim.deadlineAt ? <p className="mt-2 text-sm text-orange-100">Time remaining: <ClaimCountdown deadlineAt={claim.deadlineAt} databaseTime={databaseTime} className="font-mono font-semibold" /></p> : null}
      <p className="mt-2 text-xs text-white/55">Your active 2FA-protected Profile Wallet is used automatically. If you do not have one, enter your own SOL recipient here.</p>
      <input name="manual_recipient" className="mt-3 w-full rounded bg-black p-3 text-sm" placeholder="Optional personal SOL recipient" />
      <div className="mt-3 flex gap-2"><button disabled={busy === claim.claimPublicId} className="rounded bg-orange-600 px-4 py-2 text-sm font-semibold">Confirm return</button><button type="button" disabled={busy === claim.claimPublicId} onClick={() => act(claim, "decline", new FormData())} className="rounded border border-white/20 px-4 py-2 text-sm">Decline</button></div>
    </form>)}</div>
  </section>;
}
