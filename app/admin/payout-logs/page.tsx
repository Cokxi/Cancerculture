export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getTeamPayoutLogs } from "@/lib/payouts/service.server";

type LogRow = Record<string, unknown>;

const eventLabels: Record<string, string> = {
  pool_created: "Prize pool created",
  pool_changed: "Prize pool changed",
  pool_cleared: "Prize pool removed",
  pool_locked: "Prize pool locked at Cycle end",
  pool_amount_pending: "Cycle ended without a prize pool",
  allocation_created: "Winner amount calculated",
  donation_correction_requested: "Winner asked to change charity",
  donation_correction_submitted: "Winner submitted a new charity",
  donation_correction_expired: "Charity change window expired",
  donation_correction_completed: "Charity change completed",
  payout_disqualified: "Payout blocked",
  transaction_verified: "Transaction verified",
  evidence_attached: "Donation receipt attached",
  plan_published: "Payout published",
};

function eventLabel(value: unknown) {
  const key = String(value ?? "");
  return eventLabels[key] ?? key.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

export default async function PayoutLogsPage() {
  const authorization = await requireTeamCapabilityPage("winners.payout_logs.view", "/admin/payout-logs");
  const items = await getTeamPayoutLogs(authorization.discord_user_id);
  return <div>
    <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">Payout Logs</h1>
    <p className="mt-3 max-w-3xl text-sm text-white/60">Read-only audit history. The everyday payout workflow stays on the Payouts page; technical evidence remains available here only when it is needed.</p>
    <div className="mt-6 space-y-3">{(items as LogRow[]).map((item) => <article key={String(item.eventId)} className="rounded-lg border border-white/10 bg-black/35 p-4 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><strong>{eventLabel(item.eventType)}</strong><time className="text-white/50">{new Date(String(item.occurredAt)).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</time></div>
      {item.reason ? <p className="mt-2 text-white/75">Reason: {String(item.reason)}</p> : null}
      <details className="mt-3 rounded-lg border border-white/10 p-3 text-xs text-white/55">
        <summary className="cursor-pointer font-semibold text-white/65">Audit details</summary>
        <div className="mt-2 break-all">{String(item.targetType)} · {String(item.targetPublicId)} · version {String(item.targetVersion)}</div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(item.details ?? {}, null, 2)}</pre>
      </details>
    </article>)}</div>
  </div>;
}
