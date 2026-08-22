export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getTeamPayoutLogs } from "@/lib/payouts/service.server";

type LogRow = Record<string, unknown> & {
  cycleNumber?: number | null;
  cycleStatus?: string | null;
};

type CycleLogGroup = {
  cycleNumber: number;
  cycleStatus: string | null;
  items: LogRow[];
};

const eventLabels: Record<string, string> = {
  pool_created: "Prize pool created",
  pool_changed: "Prize pool changed",
  pool_cleared: "Prize pool removed",
  pool_locked: "Prize pool locked at Cycle end",
  pool_amount_pending: "Cycle ended without a prize pool",
  pool_component_added: "Prize pool component added",
  allocation_created: "Winner amount calculated",
  plan_prepared: "Payout prepared",
  plan_locked: "Payout locked",
  plan_aborted: "Payout cancelled",
  plan_replaced: "Payout replaced",
  donation_recipient_set: "Donation recipient set",
  donation_unavailable: "Donation unavailable",
  donation_correction_requested: "Winner asked to change charity",
  donation_correction_submitted: "Winner submitted a new charity",
  donation_correction_expired: "Charity change window expired",
  donation_correction_completed: "Charity change completed",
  payout_disqualified: "Payout blocked",
  transaction_issued: "Transaction recorded",
  transaction_verified: "Transaction verified",
  evidence_attached: "Donation receipt attached",
  poll_linked: "Community decision linked",
  poll_outcome_applied: "Community decision applied",
  rollover_created: "Prize rolled into another Cycle",
  organization_redirected: "Donation redirected",
  return_claim_created: "Winner return claim opened",
  follow_up_linked: "Follow-up decision linked",
  return_claim_confirmed: "Winner return claim confirmed",
  return_claim_declined: "Winner return claim declined",
  return_claim_expired: "Winner return claim expired",
  plan_published: "Payout published",
};

function eventLabel(value: unknown) {
  const key = String(value ?? "");
  return eventLabels[key] ?? key.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function eventTime(value: unknown) {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "UTC",
        timeZoneName: "short",
      });
}

function groupPayoutLogsByCycle(items: LogRow[]) {
  const groups = new Map<number, CycleLogGroup>();
  const unassigned: LogRow[] = [];

  for (const item of items) {
    if (!Number.isSafeInteger(item.cycleNumber) || Number(item.cycleNumber) <= 0) {
      unassigned.push(item);
      continue;
    }

    const cycleNumber = Number(item.cycleNumber);
    const group = groups.get(cycleNumber) ?? {
      cycleNumber,
      cycleStatus: typeof item.cycleStatus === "string" ? item.cycleStatus : null,
      items: [],
    };
    group.items.push(item);
    groups.set(cycleNumber, group);
  }

  const numberedGroups = [...groups.values()].sort(
    (left, right) => right.cycleNumber - left.cycleNumber
  );
  return { numberedGroups, unassigned };
}

function LogCard({ item }: { item: LogRow }) {
  const occurredAt = String(item.occurredAt ?? "");

  return (
    <article className="flex h-full min-w-0 flex-col rounded-xl border border-white/10 bg-black/35 p-4 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3">
        <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-white/50">Time</dt>
        <dd className="min-w-0 text-right text-white/75">
          <time dateTime={occurredAt}>{eventTime(occurredAt)}</time>
        </dd>
        <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-white/50">Action</dt>
        <dd className="min-w-0 text-right font-semibold text-white">
          {eventLabel(item.eventType)}
        </dd>
        {item.reason ? (
          <>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-white/50">Reason</dt>
            <dd className="min-w-0 break-words text-right text-white/80">{String(item.reason)}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}

function CycleGroup({ group, index }: { group: CycleLogGroup; index: number }) {
  const isCurrent = group.cycleStatus !== null && group.cycleStatus !== "finished";

  return (
    <details
      open={index === 0}
      className="group rounded-xl border border-white/10 bg-black/20 open:bg-black/30"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-4 marker:content-none sm:px-5">
        <span className="flex min-w-0 flex-wrap items-center gap-3">
          <strong className="text-lg text-white">Cycle #{group.cycleNumber}</strong>
          {isCurrent ? (
            <span className="rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-semibold text-emerald-300">
              Current Cycle
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-3 text-sm text-white/60">
          {group.items.length} {group.items.length === 1 ? "action" : "actions"}
          <span aria-hidden="true" className="text-[var(--orange-light)] transition-transform group-open:rotate-180">
            ▼
          </span>
        </span>
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t border-white/10 p-4 lg:grid-cols-2 2xl:grid-cols-3 sm:p-5">
        {group.items.map((item) => (
          <LogCard key={String(item.eventId)} item={item} />
        ))}
      </div>
    </details>
  );
}

export function PayoutLogPresentation({ items }: { items: LogRow[] }) {
  const { numberedGroups, unassigned } = groupPayoutLogsByCycle(items);

  return (
    <section className="mx-auto max-w-7xl">
      <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">Payout Logs</h1>
      <p className="mt-3 max-w-3xl text-sm text-white/60">
        Read-only audit history, grouped by Cycle. The everyday payout workflow stays on the Payouts page;
        this page shows the relevant actions without technical raw data.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a
          href="/api/admin/payout-logs/export"
          className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/75 transition hover:border-[var(--orange-light)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-light)]"
        >
          Download technical audit
        </a>
        <p className="max-w-xl text-xs text-white/50">
          JSON export for troubleshooting only. Keep the downloaded file private.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="mt-6 rounded-xl border border-white/10 bg-black/25 p-5 text-sm text-white/60">
          No payout actions have been logged yet.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {numberedGroups.map((group, index) => (
            <CycleGroup key={group.cycleNumber} group={group} index={index} />
          ))}
          {unassigned.length > 0 ? (
            <details className="rounded-xl border border-white/10 bg-black/20">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 marker:content-none sm:px-5">
                <strong className="text-lg text-white">Other payout actions</strong>
                <span className="text-sm text-white/60">
                  {unassigned.length} {unassigned.length === 1 ? "action" : "actions"}
                </span>
              </summary>
              <div className="grid grid-cols-1 gap-4 border-t border-white/10 p-4 lg:grid-cols-2 2xl:grid-cols-3 sm:p-5">
                {unassigned.map((item) => (
                  <LogCard key={String(item.eventId)} item={item} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default async function PayoutLogsPage() {
  const authorization = await requireTeamCapabilityPage("winners.payout_logs.view", "/admin/payout-logs");
  const items = (await getTeamPayoutLogs(authorization.discord_user_id)) as LogRow[];
  return <PayoutLogPresentation items={items} />;
}
