import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getPublicCycleNumberMap } from "@/lib/cycles/publicCycleNumber";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getSponsorRollingUniqueWindowStart,
  getSponsorSurfaceLabel,
  getSponsorReportStats,
  SPONSOR_REPORT_METHODOLOGY,
  SPONSOR_REPORT_STATUS,
  type SponsorTrackingAggregateForReport,
  type SponsorTrackingEventForReport,
} from "@/lib/sponsors/report";
import type {
  SponsorEventType,
  SponsorTrackingSurface,
} from "@/lib/sponsors/tracking";

type SponsorshipRow = {
  id: number;
  cycle_id: number;
  sponsor_name: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
};

type TrackingEventRow = {
  sponsorship_id: number;
  event_type: SponsorEventType;
  surface: SponsorTrackingSurface;
  viewer_hash: string;
  feed_kind: "live" | "top10" | "all" | "trash" | null;
  created_at: string;
};

type TrackingAggregateRow = SponsorTrackingAggregateForReport & {
  sponsorship_id: number;
};

function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }

  return `${value.toFixed(1)}%`;
}

export default async function SponsorLogsPage() {
  await requireTeamCapabilityPage(
    "sponsorships.reports.view",
    "/admin/logs/sponsors"
  );

  const sponsorshipsResult = await supabaseAdmin
    .from("cycle_sponsorships")
    .select(
      "id, cycle_id, sponsor_name, starts_at, ends_at, created_at"
    )
    .order("created_at", { ascending: false });

  if (sponsorshipsResult.error) {
    return (
      <div>
        <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          Sponsor Reports
        </h1>
        <div className="mt-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-5 text-yellow-100">
          Sponsor tracking tables are not available yet. Run
          <code className="mx-1 rounded bg-black/40 px-1">
            supabase/sponsorship_tracking.sql
          </code>
          in Supabase first.
        </div>
      </div>
    );
  }

  const sponsorships =
    (sponsorshipsResult.data ?? []) as SponsorshipRow[];
  const sponsorshipIds = sponsorships.map(
    (sponsorship) => sponsorship.id
  );
  const publicCycleNumberById = await getPublicCycleNumberMap(
    sponsorships.map((sponsorship) => sponsorship.cycle_id)
  );
  const rollingUniqueWindowStart = getSponsorRollingUniqueWindowStart();
  const [eventsResult, aggregatesResult] =
    sponsorshipIds.length > 0
      ? await Promise.all([
          supabaseAdmin
          .from("sponsor_tracking_events")
          .select("sponsorship_id, event_type, surface, feed_kind, viewer_hash, created_at")
          .in("sponsorship_id", sponsorshipIds)
          .gte("created_at", rollingUniqueWindowStart),
          supabaseAdmin
            .from("sponsor_tracking_aggregates")
            .select("sponsorship_id, event_day, event_type, surface, feed_kind, event_count")
            .in("sponsorship_id", sponsorshipIds),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];

  if (eventsResult.error || aggregatesResult.error) {
    return (
      <div>
        <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          Sponsor Reports
        </h1>
        <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-red-100">
          Failed to load sponsor tracking events.
        </div>
      </div>
    );
  }

  const events = (eventsResult.data ?? []) as TrackingEventRow[];
  const eventsBySponsorshipId = new Map<number, TrackingEventRow[]>();
  const aggregatesBySponsorshipId = new Map<number, TrackingAggregateRow[]>();

  for (const event of events) {
    eventsBySponsorshipId.set(event.sponsorship_id, [
      ...(eventsBySponsorshipId.get(event.sponsorship_id) ?? []),
      event,
    ]);
  }
  for (const aggregate of (aggregatesResult.data ?? []) as TrackingAggregateRow[]) {
    aggregatesBySponsorshipId.set(aggregate.sponsorship_id, [
      ...(aggregatesBySponsorshipId.get(aggregate.sponsorship_id) ?? []),
      aggregate,
    ]);
  }

  return (
    <div>
      <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
        Sponsor Reports
      </h1>
      <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
        <div className="font-semibold">{SPONSOR_REPORT_STATUS.label}</div>
        <p className="mt-1 text-red-100/80">
          {SPONSOR_REPORT_STATUS.notice}
        </p>
      </div>

      {sponsorships.length === 0 ? (
        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-6 text-white/70">
          No sponsored cycles yet.
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {sponsorships.map((sponsorship) => {
            const cycleNumber = publicCycleNumberById.get(
              sponsorship.cycle_id
            );
            const stats = getSponsorReportStats(
              (eventsBySponsorshipId.get(sponsorship.id) ??
                []) as SponsorTrackingEventForReport[],
              aggregatesBySponsorshipId.get(sponsorship.id) ?? []
            );

            return (
              <section
                key={sponsorship.id}
                className="rounded-xl border border-white/10 bg-black/40 p-5"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-white">
                      {sponsorship.sponsor_name}
                    </h2>
                    <div className="mt-1 text-sm text-white/60">
                      Cycle #{cycleNumber}
                    </div>
                  </div>

                  <div className="flex flex-col items-start gap-3 text-sm text-white/60 sm:items-end">
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      <a
                        href={`/api/admin/sponsors/cycle/${cycleNumber}/export`}
                        className="rounded-full border border-white/15 bg-white/5 px-3 py-2 text-xs text-white transition hover:border-[var(--orange-dark)]/50 hover:bg-white/10"
                      >
                        Export aggregate JSON
                      </a>
                      <a
                        href={`/api/admin/sponsors/cycle/${cycleNumber}/export?format=pdf`}
                        className="rounded-full border border-[var(--orange-dark)]/50 bg-[var(--orange-dark)]/10 px-3 py-2 text-xs text-orange-100 transition hover:bg-[var(--orange-dark)]/20"
                      >
                        Export presentation PDF
                      </a>
                    </div>
                    <div>
                      <div>
                        Started:{" "}
                        {sponsorship.starts_at
                          ? new Date(
                              sponsorship.starts_at
                            ).toLocaleString()
                          : "-"}
                      </div>
                      <div>
                        Ended:{" "}
                        {sponsorship.ends_at
                          ? new Date(
                              sponsorship.ends_at
                            ).toLocaleString()
                          : "-"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-lg bg-white/5 p-3">
                    <div className="text-xs text-white/50">
                      Impressions
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {stats.impressions}
                    </div>
                  </div>
                  <div className="rounded-lg bg-white/5 p-3">
                    <div className="text-xs text-white/50">
                      Unique Views (30d)
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {stats.uniqueViews}
                    </div>
                  </div>
                  <div className="rounded-lg bg-white/5 p-3">
                    <div className="text-xs text-white/50">
                      Clicks
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {stats.clicks}
                    </div>
                  </div>
                  <div className="rounded-lg bg-white/5 p-3">
                    <div className="text-xs text-white/50">
                      Unique Clicks (30d)
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {stats.uniqueClicks}
                    </div>
                  </div>
                  <div className="rounded-lg bg-white/5 p-3">
                    <div className="text-xs text-white/50">
                      CTR
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatPercent(stats.ctr)}
                    </div>
                  </div>
                </div>

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left text-sm">
                    <thead className="text-white/50">
                      <tr>
                        <th className="py-2">Surface</th>
                        <th className="py-2">Impressions</th>
                        <th className="py-2">Unique Views (30d)</th>
                        <th className="py-2">Clicks</th>
                        <th className="py-2">Unique Clicks (30d)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(stats.surfaceStats.entries()).map(
                        ([surface, surfaceStats]) => (
                          <tr
                            key={surface}
                            className="border-t border-white/10"
                          >
                            <td className="py-2">
                              {getSponsorSurfaceLabel(surface)}
                            </td>
                            <td className="py-2">
                              {surfaceStats.impressions}
                            </td>
                            <td className="py-2">
                              {surfaceStats.uniqueViews}
                            </td>
                            <td className="py-2">
                              {surfaceStats.clicks}
                            </td>
                            <td className="py-2">
                              {surfaceStats.uniqueClicks}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-xs leading-5 text-white/60">
                  <div className="font-semibold text-white/80">
                    Aggregate measurement methodology
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>{SPONSOR_REPORT_METHODOLOGY.analytics_consent}</li>
                    <li>{SPONSOR_REPORT_METHODOLOGY.qualified_impression}</li>
                    <li>{SPONSOR_REPORT_METHODOLOGY.deduplication}</li>
                    <li>{SPONSOR_REPORT_METHODOLOGY.rolling_uniques}</li>
                    <li>{SPONSOR_REPORT_METHODOLOGY.aggregate_retention}</li>
                  </ul>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
