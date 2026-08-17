"use client";

import { validateSolRecipientAddress } from "@/lib/solana/address";
import type { TeamWinnerClaim } from "@/lib/winnerClaims/service.server";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

const inputClass =
  "min-h-11 w-full rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-orange-300";
const buttonClass =
  "min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";

export default function WinnerCorrectionControls({ winner }: { winner: TeamWinnerClaim }) {
  const router = useRouter();
  const latest = winner.latestCorrection;
  const [address, setAddress] = useState(latest?.proposedRecipient ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const validation = useMemo(() => validateSolRecipientAddress(address), [address]);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/winner-recipient-corrections", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          claimId: winner.claimId,
          expectedClaimVersion: winner.claimVersion,
          proposedRecipient: validation.ok ? validation.address : null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = body.outcome ?? body.error;
        throw new Error(typeof code === "string" ? code : "UNAVAILABLE");
      }
      setNotice("Correction proposal is ready. The winner received a fresh 24-hour review window.");
      router.refresh();
    } catch (requestError) {
      const code = requestError instanceof Error ? requestError.message : "UNAVAILABLE";
      setError(code === "claim_stale" ? "The Claim changed in another request. Refresh and review the latest version." : code === "not_manual_recipient" ? "Corrections are limited to winners whose frozen Upload recipient was manual." : "The correction was not accepted. No recipient or Claim state was changed.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-orange-300/20 bg-orange-950/10 p-4" aria-busy={busy}>
      <h3 className="font-semibold text-orange-100">Winner recipient correction</h3>
      <p className="mt-2 text-xs leading-relaxed text-white/55">This creates a new proposed recipient and a fresh 24-hour review window. It cannot confirm for the winner or manage a payout.</p>
      {latest ? (
        <div className="mt-3 rounded-md bg-black/35 p-3 text-xs text-white/70">
          <p>Latest version #{latest.version}: {latest.status}</p>
          {latest.proposedRecipient ? <code className="mt-2 block max-w-full overflow-x-auto whitespace-nowrap font-mono text-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{latest.proposedRecipient}</code> : null}
        </div>
      ) : null}
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mt-3 rounded-md bg-red-950/35 p-3 text-sm text-red-100 outline-none">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 rounded-md bg-emerald-950/30 p-3 text-sm text-emerald-100">{notice}</p> : null}
      <label className="mt-4 block text-xs font-semibold text-white/75">Proposed SOL recipient<input className={`${inputClass} mt-1 font-mono`} value={address} onChange={(event) => setAddress(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" className={`${buttonClass} border-orange-300/35`} disabled={busy || !validation.ok} onClick={() => void submit()}>Propose correction and start 24h</button>
      </div>
    </section>
  );
}
