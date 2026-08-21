import { formatLamportsAsSol } from "@/lib/payouts/amount";
import type { PublicPayoutDetails as Details } from "@/lib/payouts/public";

const statusLabels: Record<Details["state"], string> = {
  paid: "Payout completed",
  claim_expired: "Prize not claimed within 24 hours",
  claim_declined: "Winner declined the claim",
  donation_change_required: "Winner must choose another charity",
  donation_review_pending: "New charity is being reviewed",
  donation_change_expired: "Charity change window expired",
  payout_disqualified: "Payout blocked",
};

function amount(value: string) {
  return `${formatLamportsAsSol(value)} SOL`;
}

export default function PublicPayoutDetails({ payout }: { payout: Details | null }) {
  if (!payout) return null;
  return <details className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3 text-sm">
    <summary className="cursor-pointer font-semibold text-orange-200">Winner payout details</summary>
    <div className="mt-3 space-y-3 text-white/75">
      <p className="font-semibold text-white">{statusLabels[payout.state]}</p>
      {payout.publicReason ? <p className="rounded-lg border border-yellow-300/20 bg-yellow-300/[0.05] p-2"><strong>Public reason:</strong> {payout.publicReason}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div><span className="block text-xs text-white/45">Prize share</span>{amount(payout.grossLamports)}</div>
        <div><span className="block text-xs text-white/45">Winner</span>{amount(payout.winnerLamports)}</div>
        <div><span className="block text-xs text-white/45">Donation</span>{amount(payout.donationLamports)}</div>
      </div>
      {payout.winnerRecipient ? <div><strong>Winner wallet</strong><code className="mt-1 block select-all break-all rounded bg-black/40 p-2 text-xs text-green-300">{payout.winnerRecipient}</code></div> : null}
      {payout.winnerTransactions.length > 0 ? <div className="space-y-1">{payout.winnerTransactions.map((transaction, index) => <a key={transaction.signature} href={transaction.canonicalExplorerUrl} target="_blank" rel="noreferrer" className="block break-all text-orange-300 underline">Winner transaction {index + 1} · {amount(transaction.verifiedLamports)}</a>)}</div> : payout.winnerTransactionUrl ? <a href={payout.winnerTransactionUrl} target="_blank" rel="noreferrer" className="block break-all text-orange-300 underline">Open winner transaction on Solana Explorer</a> : null}
      {payout.winnerPaidLamports && payout.winnerPaidLamports !== payout.winnerLamports ? <p><strong>Winner actually paid:</strong> {amount(payout.winnerPaidLamports)}</p> : null}
      {payout.winnerOverpaymentReason ? <p className="rounded-lg border border-yellow-300/20 bg-yellow-300/[0.05] p-2"><strong>Winner overpayment:</strong> {payout.winnerOverpaymentReason}</p> : null}
      {payout.organizationName ? <div><strong>Charity:</strong> {payout.organizationWebsiteUrl ? <a href={payout.organizationWebsiteUrl} target="_blank" rel="noreferrer" className="ml-1 text-orange-300 underline">{payout.organizationName}</a> : payout.organizationName}</div> : null}
      {payout.donationRecipient ? <div><strong>Donation wallet</strong><code className="mt-1 block select-all break-all rounded bg-black/40 p-2 text-xs text-green-300">{payout.donationRecipient}</code></div> : null}
      {payout.donationTransactions.length > 0 ? <div className="space-y-1">{payout.donationTransactions.map((transaction, index) => <a key={transaction.signature} href={transaction.canonicalExplorerUrl} target="_blank" rel="noreferrer" className="block break-all text-orange-300 underline">Donation transaction {index + 1} · {amount(transaction.verifiedLamports)}</a>)}</div> : payout.donationTransactionUrl ? <a href={payout.donationTransactionUrl} target="_blank" rel="noreferrer" className="block break-all text-orange-300 underline">Open donation transaction on Solana Explorer</a> : null}
      {payout.donationPaidLamports && payout.donationPaidLamports !== payout.donationLamports ? <p><strong>Donation actually paid:</strong> {amount(payout.donationPaidLamports)}</p> : null}
      {payout.donationOverpaymentReason ? <p className="rounded-lg border border-yellow-300/20 bg-yellow-300/[0.05] p-2"><strong>Donation overpayment:</strong> {payout.donationOverpaymentReason}</p> : null}
      {payout.receiptPublicId ? <a href={`/api/payout-receipts/${payout.receiptPublicId}`} target="_blank" rel="noreferrer" className="block text-orange-300 underline">View public donation receipt</a> : null}
    </div>
  </details>;
}
