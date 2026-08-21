"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ClaimCountdown from "@/app/components/winners/ClaimCountdown";
import { formatLamportsAsSol } from "@/lib/payouts/amount";
import type { SimpleTeamPayoutItem } from "@/lib/payouts/service.server";

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(row) : [];
}

function amount(value: unknown) {
  return typeof value === "string" && /^[0-9]+$/u.test(value)
    ? `${formatLamportsAsSol(value)} SOL`
    : "—";
}

function claimLabel(status: string) {
  switch (status) {
    case "confirmed": return "Claim confirmed";
    case "unclaimed": return "Waiting for winner claim";
    case "expired": return "Not claimed within 24 hours";
    case "declined": return "Claim declined";
    case "not_required": return "No winner wallet required";
    default: return "Claim unavailable";
  }
}

function readableError(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  if (!value.startsWith("PAYOUT_")) return value;
  if (value.includes("STATE_CONFLICT") || value.includes("STALE")) return "This payout changed. Refresh the page and check the current status.";
  if (value.includes("CORRECTION_REQUIRED")) return "The charity change must be completed before this payout can be published.";
  if (value.includes("DISQUALIFIED")) return "This payout is blocked and can no longer be published.";
  if (value.includes("ORGANIZATION")) return "The charity name and official website must be checked before continuing.";
  if (value.includes("VERIFICATION")) return "The transaction does not match the exact wallet and amount.";
  return fallback;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="text-xs uppercase tracking-wide text-white/45">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-green-300" title={value}>{value}</code>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-orange-400/35 px-2 py-1 text-xs text-orange-200 hover:bg-orange-500/10"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function WinnerCard({
  item,
  canManage,
  databaseTime,
}: {
  item: SimpleTeamPayoutItem;
  canManage: boolean;
  databaseTime: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verification, setVerification] = useState<Row>({});
  const [winnerTransactions, setWinnerTransactions] = useState([""]);
  const [donationWallet, setDonationWallet] = useState("");
  const [donationTransactions, setDonationTransactions] = useState([""]);
  const [winnerOverpaymentReason, setWinnerOverpaymentReason] = useState("");
  const [donationOverpaymentReason, setDonationOverpaymentReason] = useState("");
  const [unavailableReason, setUnavailableReason] = useState("");
  const [disqualificationReason, setDisqualificationReason] = useState("");

  const allocationPublicId = text(item.allocationPublicId);
  const claimStatus = text(item.claimStatus);
  const winnerLamports = text(item.winnerLamports);
  const donationLamports = text(item.donationLamports);
  const winnerRequired = /^[1-9][0-9]*$/u.test(winnerLamports);
  const donationRequired = /^[1-9][0-9]*$/u.test(donationLamports);
  const correction = row(item.correction);
  const correctionStatus = text(correction.status);
  const disqualification = row(item.disqualification);
  const plan = row(item.plan);
  const planState = text(plan.state);
  const winnerLine = row(plan.winnerLine);
  const donationLine = row(plan.donationLine);
  const published = planState === "published";
  const disqualified = Boolean(disqualification.disqualificationPublicId);
  const correctionBlocking = ["open", "expired"].includes(correctionStatus);
  const organizationName = text(item.organizationName);
  const organizationUrl = text(item.organizationWebsiteUrl);
  const ready = !published && !disqualified && !correctionBlocking &&
    (claimStatus === "confirmed" || claimStatus === "not_required");

  async function postJson(path: string, body: Row) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(readableError(payload.error, "The action could not be saved."));
      setMessage("Saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The action could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function publish(formData: FormData) {
    setBusy(true);
    setMessage(null);
    try {
      formData.set("requestId", crypto.randomUUID());
      formData.set("allocationPublicId", allocationPublicId);
      formData.set("expectedClaimVersion", String(item.claimVersion ?? ""));
      const response = await fetch(`/api/admin/payouts/${allocationPublicId}/publish`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setVerification(row(payload.verification));
        throw new Error(readableError(payload.error, "Payout could not be published."));
      }
      setVerification({});
      setMessage("Payout verified and published.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payout could not be published.");
    } finally {
      setBusy(false);
    }
  }

  const winnerCheck = row(verification.winner);
  const donationCheck = row(verification.donation);
  const winnerPublishedTransactions = rows(winnerLine.transactions);
  const donationPublishedTransactions = rows(donationLine.transactions);

  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-black/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-white/45">Submission #{String(item.submissionId)}</p>
          <h3 className="mt-1 text-lg font-semibold text-white">{text(item.winnerDisplayName) || "Winner"}</h3>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${published ? "bg-green-400/15 text-green-200" : disqualified ? "bg-red-400/15 text-red-200" : "bg-orange-400/15 text-orange-200"}`}>
          {published ? "Published" : disqualified ? "Payout blocked" : "Payout pending"}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-xl bg-white/[0.04] p-3"><span className="block text-xs text-white/45">Prize share</span>{amount(item.grossLamports)}</div>
        <div className="rounded-xl bg-white/[0.04] p-3"><span className="block text-xs text-white/45">Winner</span>{amount(item.winnerLamports)}</div>
        <div className="rounded-xl bg-white/[0.04] p-3"><span className="block text-xs text-white/45">Donation</span>{amount(item.donationLamports)}</div>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{claimLabel(claimStatus)}</strong>
          {claimStatus === "unclaimed" && text(item.claimDeadlineAt) ? (
            <ClaimCountdown deadlineAt={text(item.claimDeadlineAt)} databaseTime={databaseTime} className="font-mono text-orange-200" />
          ) : null}
        </div>
        {winnerRequired && text(item.winnerRecipient) ? <div className="mt-3"><CopyValue value={text(item.winnerRecipient)} label="Confirmed winner wallet" /></div> : null}
      </div>

      {donationRequired ? (
        <div className="mt-3 rounded-xl border border-white/10 p-3 text-sm">
          <span className="block text-xs uppercase tracking-wide text-white/45">Selected charity</span>
          {organizationUrl ? <a href={organizationUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-semibold text-orange-300 underline decoration-orange-300/40 underline-offset-4">{organizationName || "Open charity website"}</a> : <strong className="mt-1 block">{organizationName || "Charity details need review"}</strong>}
          {item.organizationReviewRequired === true ? <p className="mt-2 text-xs text-yellow-200">This “Other” entry must be checked against its official website before saving the payout.</p> : null}
        </div>
      ) : null}

      {correctionStatus ? (
        <div className="mt-3 rounded-xl border border-yellow-300/25 bg-yellow-300/[0.06] p-3 text-sm text-yellow-100">
          <strong>{correctionStatus === "open" ? "Winner must choose another charity" : correctionStatus === "submitted" ? "New charity submitted — Team review pending" : correctionStatus === "expired" ? "24-hour charity change window expired" : "Charity correction completed"}</strong>
          {text(correction.publicReason) ? <p className="mt-1 text-xs text-yellow-100/75">Reason: {text(correction.publicReason)}</p> : null}
          {correctionStatus === "open" && text(correction.deadlineAt) ? <p className="mt-2 text-xs">Time remaining: <ClaimCountdown deadlineAt={text(correction.deadlineAt)} databaseTime={databaseTime} className="font-mono font-semibold" /></p> : null}
        </div>
      ) : null}

      {disqualified ? <div className="mt-3 rounded-xl border border-red-400/25 bg-red-400/[0.06] p-3 text-sm text-red-100"><strong>Payout blocked</strong><p className="mt-1 text-xs">Reason: {text(disqualification.publicReason)}</p><p className="mt-2 text-xs text-white/55">The winning submission remains visible. Any Community Decision must be started manually.</p></div> : null}

      {published ? (
        <div className="mt-4 space-y-3 rounded-xl border border-green-400/20 bg-green-400/[0.04] p-3 text-sm">
          <strong className="text-green-200">Completed transaction details</strong>
          {winnerPublishedTransactions.length > 0 ? <div className="space-y-1">{winnerPublishedTransactions.map((transaction, index) => (
            <a key={text(transaction.signature)} className="block break-all text-orange-300 underline" href={text(transaction.canonicalExplorerUrl)} target="_blank" rel="noreferrer">Winner transaction {index + 1} · {amount(transaction.verifiedLamports)}</a>
          ))}</div> : text(winnerLine.transactionUrl) ? <a className="block break-all text-orange-300 underline" href={text(winnerLine.transactionUrl)} target="_blank" rel="noreferrer">Winner transaction on Solana Explorer</a> : null}
          {text(winnerLine.paidLamports) ? <p className="text-xs text-white/60">Winner paid: {amount(winnerLine.paidLamports)}</p> : null}
          {text(winnerLine.overpaymentReason) ? <p className="rounded-lg border border-yellow-300/20 bg-yellow-300/[0.05] p-2 text-xs text-yellow-100">Overpayment reason: {text(winnerLine.overpaymentReason)}</p> : null}
          {text(donationLine.recipient) ? <CopyValue value={text(donationLine.recipient)} label="Donation operation wallet" /> : null}
          {donationPublishedTransactions.length > 0 ? <div className="space-y-1">{donationPublishedTransactions.map((transaction, index) => (
            <a key={text(transaction.signature)} className="block break-all text-orange-300 underline" href={text(transaction.canonicalExplorerUrl)} target="_blank" rel="noreferrer">Donation transaction {index + 1} · {amount(transaction.verifiedLamports)}</a>
          ))}</div> : text(donationLine.transactionUrl) ? <a className="block break-all text-orange-300 underline" href={text(donationLine.transactionUrl)} target="_blank" rel="noreferrer">Donation transaction on Solana Explorer</a> : null}
          {text(donationLine.paidLamports) ? <p className="text-xs text-white/60">Donation paid: {amount(donationLine.paidLamports)}</p> : null}
          {text(donationLine.overpaymentReason) ? <p className="rounded-lg border border-yellow-300/20 bg-yellow-300/[0.05] p-2 text-xs text-yellow-100">Overpayment reason: {text(donationLine.overpaymentReason)}</p> : null}
          {text(donationLine.receiptPublicId) ? <a className="block text-orange-300 underline" href={`/api/admin/payout-evidence/${text(donationLine.receiptPublicId)}`} target="_blank" rel="noreferrer">View donation receipt</a> : null}
        </div>
      ) : null}

      {canManage && ready ? (
        <form action={publish} className="mt-4 space-y-3 rounded-xl border border-orange-400/25 bg-orange-400/[0.04] p-3">
          <h4 className="font-semibold text-orange-200">Complete payout</h4>
          <p className="text-xs text-white/55">Enter every completed on-chain transaction. The server verifies the recipient and adds the confirmed amounts before anything is published.</p>
          {winnerRequired ? <div className="space-y-2">
            {winnerTransactions.map((value, index) => <div key={index} className="flex items-end gap-2">
              <label className="min-w-0 flex-1 text-xs text-white/70">Winner transaction {index + 1}<input name="winnerTransaction" value={value} onChange={(event) => {
                const next = [...winnerTransactions]; next[index] = event.target.value; setWinnerTransactions(next); setVerification({});
              }} required className="mt-1 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm text-white" /></label>
              {winnerTransactions.length > 1 ? <button type="button" onClick={() => { setWinnerTransactions(winnerTransactions.filter((_, itemIndex) => itemIndex !== index)); setVerification({}); }} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/65">Remove</button> : null}
            </div>)}
            {winnerTransactions.length < 10 ? <button type="button" onClick={() => { setWinnerTransactions([...winnerTransactions, ""]); setVerification({}); }} className="rounded-lg border border-orange-300/30 px-3 py-2 text-xs text-orange-200">Add another winner transaction</button> : null}
            {text(winnerCheck.status) ? <div className={`rounded-lg border p-3 text-xs ${text(winnerCheck.status) === "underpaid" ? "border-yellow-300/25 bg-yellow-300/[0.05] text-yellow-100" : text(winnerCheck.status) === "overpaid" ? "border-orange-300/25 bg-orange-300/[0.05] text-orange-100" : "border-green-300/25 bg-green-300/[0.05] text-green-100"}`}>
              <p>Expected: {amount(winnerCheck.expectedLamports)} · Verified: {amount(winnerCheck.actualLamports)}</p>
              {text(winnerCheck.status) === "underpaid" ? <p className="mt-1 font-semibold">Still due: {amount(winnerCheck.differenceLamports)}</p> : null}
              {text(winnerCheck.status) === "overpaid" ? <div className="mt-2 space-y-2">
                <p className="font-semibold">Overpaid by {amount(winnerCheck.differenceLamports)}</p>
                <label className="flex items-start gap-2"><input name="winnerOverpaymentConfirmed" type="checkbox" value="true" required className="mt-0.5" />Publish the actual higher amount as an overpayment.</label>
                <label className="block">Public reason<textarea name="winnerOverpaymentReason" value={winnerOverpaymentReason} onChange={(event) => setWinnerOverpaymentReason(event.target.value)} required minLength={3} maxLength={500} placeholder="Clear, neutral public reason" className="mt-1 min-h-16 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm text-white" /></label>
              </div> : null}
            </div> : null}
          </div> : null}
          {donationRequired ? <>
            <label className="block text-xs text-white/70">Donation operation wallet<input name="donationWallet" value={donationWallet} onChange={(event) => { setDonationWallet(event.target.value); setVerification({}); }} required className="mt-1 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm text-white" /></label>
            <div className="space-y-2">
              {donationTransactions.map((value, index) => <div key={index} className="flex items-end gap-2">
                <label className="min-w-0 flex-1 text-xs text-white/70">Donation transaction {index + 1}<input name="donationTransaction" value={value} onChange={(event) => {
                  const next = [...donationTransactions]; next[index] = event.target.value; setDonationTransactions(next); setVerification({});
                }} required className="mt-1 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm text-white" /></label>
                {donationTransactions.length > 1 ? <button type="button" onClick={() => { setDonationTransactions(donationTransactions.filter((_, itemIndex) => itemIndex !== index)); setVerification({}); }} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/65">Remove</button> : null}
              </div>)}
              {donationTransactions.length < 10 ? <button type="button" onClick={() => { setDonationTransactions([...donationTransactions, ""]); setVerification({}); }} className="rounded-lg border border-orange-300/30 px-3 py-2 text-xs text-orange-200">Add another donation transaction</button> : null}
              {text(donationCheck.status) ? <div className={`rounded-lg border p-3 text-xs ${text(donationCheck.status) === "underpaid" ? "border-yellow-300/25 bg-yellow-300/[0.05] text-yellow-100" : text(donationCheck.status) === "overpaid" ? "border-orange-300/25 bg-orange-300/[0.05] text-orange-100" : "border-green-300/25 bg-green-300/[0.05] text-green-100"}`}>
                <p>Expected: {amount(donationCheck.expectedLamports)} · Verified: {amount(donationCheck.actualLamports)}</p>
                {text(donationCheck.status) === "underpaid" ? <p className="mt-1 font-semibold">Still due: {amount(donationCheck.differenceLamports)}</p> : null}
                {text(donationCheck.status) === "overpaid" ? <div className="mt-2 space-y-2">
                  <p className="font-semibold">Overpaid by {amount(donationCheck.differenceLamports)}</p>
                  <label className="flex items-start gap-2"><input name="donationOverpaymentConfirmed" type="checkbox" value="true" required className="mt-0.5" />Publish the actual higher amount as an overpayment.</label>
                  <label className="block">Public reason<textarea name="donationOverpaymentReason" value={donationOverpaymentReason} onChange={(event) => setDonationOverpaymentReason(event.target.value)} required minLength={3} maxLength={500} placeholder="Clear, neutral public reason" className="mt-1 min-h-16 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm text-white" /></label>
                </div> : null}
              </div> : null}
            </div>
            <label className="block text-xs text-white/70">Donation receipt (optional)<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp" className="mt-1 block w-full text-xs" /></label>
            <label className="flex items-start gap-2 text-xs text-white/65"><input name="receiptPublicApproved" type="checkbox" value="true" className="mt-0.5" />Publish the receipt with the payout details. I confirmed that it contains no private or confidential data.</label>
          </> : null}
          <button disabled={busy} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50">{busy ? "Checking…" : "Save & publish"}</button>
        </form>
      ) : null}

      {canManage && !published && !disqualified && donationRequired && !correctionBlocking ? (
        <details className="mt-4 rounded-xl border border-white/10 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-white/75">Charity cannot receive this donation</summary>
          <p className="mt-2 text-xs text-white/50">The reason is shown to the winner and publicly. A new 24-hour charity-selection window starts.</p>
          <textarea value={unavailableReason} onChange={(event) => setUnavailableReason(event.target.value)} minLength={3} maxLength={500} placeholder="Clear, neutral public reason" className="mt-3 min-h-20 w-full rounded-lg border border-white/10 bg-black/60 p-2 text-sm" />
          <button type="button" disabled={busy || unavailableReason.trim().length < 3} onClick={() => postJson(`/api/admin/payouts/${allocationPublicId}/unavailable`, { requestId: crypto.randomUUID(), publicReason: unavailableReason.trim() })} className="mt-2 rounded-lg border border-yellow-300/35 px-3 py-2 text-sm text-yellow-100 disabled:opacity-40">Notify winner</button>
        </details>
      ) : null}

      {canManage && !published && !disqualified ? (
        <details className="mt-3 rounded-xl border border-red-400/15 p-3">
          <summary className="cursor-pointer text-sm text-red-200">Block this payout</summary>
          <p className="mt-2 text-xs text-white/50">Use only for abuse or repeated invalid information. The winner and reason remain public; a Community Decision is never created automatically.</p>
          <textarea value={disqualificationReason} onChange={(event) => setDisqualificationReason(event.target.value)} minLength={3} maxLength={500} placeholder="Public reason" className="mt-3 min-h-20 w-full rounded-lg border border-red-400/20 bg-black/60 p-2 text-sm" />
          <button type="button" disabled={busy || disqualificationReason.trim().length < 3} onClick={() => postJson(`/api/admin/payouts/${allocationPublicId}/disqualify`, { requestId: crypto.randomUUID(), publicReason: disqualificationReason.trim() })} className="mt-2 rounded-lg border border-red-400/40 px-3 py-2 text-sm text-red-200 disabled:opacity-40">Block payout with public reason</button>
        </details>
      ) : null}

      {message ? <p role="status" className="mt-3 text-sm text-orange-100">{message}</p> : null}
    </article>
  );
}

export default function PayoutManager({
  items,
  canManage,
  databaseTime,
}: {
  items: SimpleTeamPayoutItem[];
  canManage: boolean;
  databaseTime: string | null;
}) {
  const cycles = useMemo(() => {
    const grouped = new Map<string, SimpleTeamPayoutItem[]>();
    for (const item of items) {
      const key = String(item.cycleNumber ?? item.cycleId ?? "—");
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items]);

  if (cycles.length === 0) return <p className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5 text-sm text-white/60">No winner payouts yet.</p>;

  return <div className="mt-7 space-y-8">{cycles.map(([cycleNumber, cycleItems]) => (
    <section key={cycleNumber}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-xl font-semibold text-orange-300">Cycle #{cycleNumber}</h2>
        <span className="text-xs text-white/45">{cycleItems.length === 1 ? "1 winner" : `${cycleItems.length} tied winners`}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {cycleItems.map((item) => <WinnerCard key={text(item.allocationPublicId)} item={item} canManage={canManage} databaseTime={databaseTime} />)}
      </div>
    </section>
  ))}</div>;
}
