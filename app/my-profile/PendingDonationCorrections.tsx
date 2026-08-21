"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ClaimCountdown from "@/app/components/winners/ClaimCountdown";
import type { PublicDonationOrganization } from "@/lib/organizations/types";
import { formatLamportsAsSol } from "@/lib/payouts/amount";
import type { OwnDonationCorrection } from "@/lib/payouts/service.server";

function CorrectionForm({ item, organizations }: { item: OwnDonationCorrection; organizations: readonly PublicDonationOrganization[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState(organizations.find((organization) => organization.selectable)?.publicKey ?? "other");
  const [otherName, setOtherName] = useState("");
  const [otherWebsiteUrl, setOtherWebsiteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const sourceType = choice === "other" ? "other" : "catalog";
      const response = await fetch(`/api/account/payout-donation-corrections/${item.correctionPublicId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: item.rowVersion,
          sourceType,
          organizationPublicKey: sourceType === "catalog" ? choice : null,
          otherName: sourceType === "other" ? otherName : null,
          otherWebsiteUrl: sourceType === "other" ? otherWebsiteUrl : null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const raw = typeof payload.error === "string" ? payload.error : "";
        throw new Error(raw.startsWith("PAYOUT_")
          ? "Your charity choice could not be saved. Refresh the page and check whether the 24-hour window is still open."
          : raw || "The charity choice could not be saved.");
      }
      setMessage("Your new charity choice was saved for Team review.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The charity choice could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="mt-4 space-y-3">
    <label className="block text-sm text-white/75">Choose a new charity
      <select value={choice} onChange={(event) => setChoice(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black p-2 text-white">
        {organizations.filter((organization) => organization.selectable).map((organization) => <option key={organization.publicKey} value={organization.publicKey}>{organization.displayName}</option>)}
        <option value="other">Other charity</option>
      </select>
    </label>
    {choice === "other" ? <div className="grid gap-3">
      <label className="text-sm text-white/75">Charity name<input value={otherName} onChange={(event) => setOtherName(event.target.value)} minLength={2} maxLength={160} className="mt-1 w-full rounded-lg border border-white/10 bg-black p-2 text-white" /></label>
      <label className="text-sm text-white/75">Official HTTPS website<input value={otherWebsiteUrl} onChange={(event) => setOtherWebsiteUrl(event.target.value)} type="url" placeholder="https://…" className="mt-1 w-full rounded-lg border border-white/10 bg-black p-2 text-white" /></label>
    </div> : null}
    <p className="text-xs text-white/50">Your payout percentage and donation amount stay unchanged. The Team checks the charity details before the payout.</p>
    <button type="button" disabled={busy || (choice === "other" && (otherName.trim().length < 2 || !otherWebsiteUrl.trim()))} onClick={submit} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Saving…" : "Save new charity"}</button>
    {message ? <p role="status" className="text-sm text-orange-100">{message}</p> : null}
  </div>;
}

export default function PendingDonationCorrections({ items, organizations, databaseTime }: { items: OwnDonationCorrection[] | null; organizations: readonly PublicDonationOrganization[]; databaseTime: string | null }) {
  if (!items?.length) return null;
  return <section className="rounded-2xl border border-yellow-300/25 bg-yellow-300/[0.05] p-5">
    <h2 className="text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">Charity change required</h2>
    <div className="mt-4 space-y-4">{items.map((item) => <article id={`donation-correction-${item.correctionPublicId}`} key={item.correctionPublicId} className="scroll-mt-6 rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex flex-wrap justify-between gap-2"><strong>Cycle #{item.cycleNumber ?? "—"} · Submission #{item.submissionId}</strong><span className="text-xs uppercase text-yellow-200">{item.status}</span></div>
      <p className="mt-2 text-sm text-white/75">Reason: {item.publicReason}</p>
      <p className="mt-1 text-xs text-white/55">Fixed donation amount: {formatLamportsAsSol(item.donationLamports)} SOL{item.splitPercent !== null ? ` · Your original ${item.splitPercent}% winner share does not change.` : ""}</p>
      {item.status === "open" && item.deadlineAt ? <p className="mt-2 text-sm text-yellow-100">Time remaining: <ClaimCountdown deadlineAt={item.deadlineAt} databaseTime={databaseTime} className="font-mono font-semibold" /></p> : null}
      {item.status === "open" ? <CorrectionForm item={item} organizations={organizations} /> : item.status === "submitted" ? <p className="mt-3 text-sm text-green-200">Your new choice was submitted and is waiting for Team review.</p> : <p className="mt-3 text-sm text-red-200">The 24-hour change window has expired.</p>}
    </article>)}</div>
  </section>;
}
