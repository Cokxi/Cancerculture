import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import type {
  SponsorEventType,
  SponsorTrackingSurface,
} from "@/lib/sponsors/tracking";

export const SPONSOR_REPORT_STATUS = {
  code: "pre_launch_test",
  label: "PRE-LAUNCH / TEST DATA",
  notice:
    "This report contains test-environment measurements collected before the public launch. It is not evidence of a live commercial campaign.",
} as const;

export const SPONSOR_REPORT_METHODOLOGY = {
  analytics_consent:
    "Analytics are recorded only after the viewer has actively allowed Sponsor Analytics. Sponsor links remain usable without analytics consent.",
  qualified_impression:
    "An impression qualifies only after at least 50% of the Sponsor surface remains continuously visible for 1,000 ms in a visible browser tab.",
  deduplication:
    "Qualified impressions and clicks are deduplicated per viewer, Sponsor surface and event type in atomic 30-minute windows.",
  rolling_uniques:
    "Unique views and unique clicks cover the rolling 30-day pseudonymous measurement window at report generation time.",
  aggregate_retention:
    "Daily aggregate counts are retained for 25 months. Raw pseudonymous measurement rows are limited to 30 days and are never included in this report.",
} as const;

export type SponsorReportSurfaceKey =
  | SponsorTrackingSurface
  | `spread:${CommunityFeedKind}`;

export type SponsorTrackingEventForReport = {
  event_type: SponsorEventType;
  surface: SponsorTrackingSurface;
  viewer_hash: string;
  feed_kind?: CommunityFeedKind | null;
  created_at?: string;
};

export type SponsorTrackingAggregateForReport = {
  event_day: string;
  event_type: SponsorEventType;
  surface: SponsorTrackingSurface;
  feed_kind: CommunityFeedKind | null;
  event_count: number;
};

export type SponsorSurfaceReport = {
  clicks: number;
  impressions: number;
  uniqueClicks: number;
  uniqueViews: number;
};

export type SponsorDailyReport = {
  clicks: number;
  ctrPercent: number;
  date: string;
  impressions: number;
};

export type SponsorReportStats = {
  clicks: number;
  ctr: number;
  dailyStats: SponsorDailyReport[];
  impressions: number;
  surfaceStats: Map<SponsorReportSurfaceKey, SponsorSurfaceReport>;
  uniqueClicks: number;
  uniqueViews: number;
};

export type SponsorReportPayload = {
  exported_at: string;
  methodology: typeof SPONSOR_REPORT_METHODOLOGY;
  note: string;
  report_status: typeof SPONSOR_REPORT_STATUS;
  sponsorship: {
    cycle_number: number;
    sponsor_name: string;
    is_active: boolean;
    starts_at: string | null;
    ends_at: string | null;
    created_at: string;
    updated_at: string;
  };
  totals: {
    impressions: number;
    unique_views: number;
    clicks: number;
    unique_clicks: number;
    ctr_percent: number;
  };
  daily: Array<{
    date: string;
    impressions: number;
    clicks: number;
    ctr_percent: number;
  }>;
  surfaces: Array<{
    surface: SponsorReportSurfaceKey;
    label: string;
    impressions: number;
    unique_views: number;
    clicks: number;
    unique_clicks: number;
    ctr_percent: number;
  }>;
};

const SURFACE_LABELS: Record<SponsorReportSurfaceKey, string> = {
  home_hud: "Homepage Sponsor banner",
  vote_modal: "Vote confirmation",
  history_modal: "Cycle History",
  fame_modal: "Hall of Fame",
  shame_modal: "Hall of Shame",
  spread_detail: "The Spread - meme detail",
  spread: "The Spread",
  "spread:live": "The Spread - Live",
  "spread:top10": "The Spread - Top 10",
  "spread:all": "The Spread - All",
  "spread:trash": "The Spread - Trash",
};

const SURFACE_ORDER = Object.keys(SURFACE_LABELS) as SponsorReportSurfaceKey[];

function getSurfaceKey(
  surface: SponsorTrackingSurface,
  feedKind: CommunityFeedKind | null | undefined
): SponsorReportSurfaceKey {
  return surface === "spread" && feedKind
    ? `spread:${feedKind}`
    : surface;
}

function getSafeCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function getCtrPercent(clicks: number, impressions: number) {
  return impressions > 0 ? (clicks / impressions) * 100 : 0;
}

export function getSponsorSurfaceLabel(surface: SponsorReportSurfaceKey) {
  return SURFACE_LABELS[surface] ?? surface;
}

export function getSponsorRollingUniqueWindowStart(now = new Date()) {
  return new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
}

export function getSponsorReportStats(
  events: SponsorTrackingEventForReport[],
  aggregates?: SponsorTrackingAggregateForReport[]
): SponsorReportStats {
  const impressions = events.filter(
    (event) => event.event_type === "impression"
  );
  const clicks = events.filter((event) => event.event_type === "click");
  const surfaceStats = new Map<
    SponsorReportSurfaceKey,
    {
      clicks: number;
      impressions: number;
      uniqueClicks: Set<string>;
      uniqueViews: Set<string>;
    }
  >();
  const dailyStats = new Map<
    string,
    { clicks: number; impressions: number }
  >();

  if (aggregates) {
    for (const aggregate of aggregates) {
      const key = getSurfaceKey(aggregate.surface, aggregate.feed_kind);
      const current = surfaceStats.get(key) ?? {
        clicks: 0,
        impressions: 0,
        uniqueClicks: new Set<string>(),
        uniqueViews: new Set<string>(),
      };
      const count = getSafeCount(aggregate.event_count);
      if (aggregate.event_type === "impression") {
        current.impressions += count;
      } else {
        current.clicks += count;
      }
      surfaceStats.set(key, current);

      const daily = dailyStats.get(aggregate.event_day) ?? {
        clicks: 0,
        impressions: 0,
      };
      if (aggregate.event_type === "impression") {
        daily.impressions += count;
      } else {
        daily.clicks += count;
      }
      dailyStats.set(aggregate.event_day, daily);
    }
  }

  for (const event of events) {
    const key = getSurfaceKey(event.surface, event.feed_kind);
    const current = surfaceStats.get(key) ?? {
      clicks: 0,
      impressions: 0,
      uniqueClicks: new Set<string>(),
      uniqueViews: new Set<string>(),
    };

    if (event.event_type === "impression") {
      if (!aggregates) current.impressions += 1;
      current.uniqueViews.add(event.viewer_hash);
    } else {
      if (!aggregates) current.clicks += 1;
      current.uniqueClicks.add(event.viewer_hash);
    }

    surfaceStats.set(key, current);
  }

  const aggregateImpressions = aggregates
    ?.filter((aggregate) => aggregate.event_type === "impression")
    .reduce(
      (sum, aggregate) => sum + getSafeCount(aggregate.event_count),
      0
    );
  const aggregateClicks = aggregates
    ?.filter((aggregate) => aggregate.event_type === "click")
    .reduce(
      (sum, aggregate) => sum + getSafeCount(aggregate.event_count),
      0
    );
  const impressionCount = aggregateImpressions ?? impressions.length;
  const clickCount = aggregateClicks ?? clicks.length;

  return {
    clicks: clickCount,
    ctr: getCtrPercent(clickCount, impressionCount),
    dailyStats: Array.from(dailyStats.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, daily]) => ({
        clicks: daily.clicks,
        ctrPercent: getCtrPercent(daily.clicks, daily.impressions),
        date,
        impressions: daily.impressions,
      })),
    impressions: impressionCount,
    surfaceStats: new Map(
      Array.from(surfaceStats.entries()).map(([surface, stats]) => [
        surface,
        {
          clicks: stats.clicks,
          impressions: stats.impressions,
          uniqueClicks: stats.uniqueClicks.size,
          uniqueViews: stats.uniqueViews.size,
        },
      ])
    ),
    uniqueClicks: new Set(clicks.map((event) => event.viewer_hash)).size,
    uniqueViews: new Set(impressions.map((event) => event.viewer_hash)).size,
  };
}

export function serializeSponsorSurfaceStats(stats: SponsorReportStats) {
  return Array.from(stats.surfaceStats.entries())
    .sort(([left], [right]) => {
      const leftIndex = SURFACE_ORDER.indexOf(left);
      const rightIndex = SURFACE_ORDER.indexOf(right);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex) ||
        left.localeCompare(right);
    })
    .map(([surface, surfaceStats]) => ({
      label: getSponsorSurfaceLabel(surface),
      surface,
      ...surfaceStats,
    }));
}

export function buildSponsorReportPayload({
  exportedAt,
  sponsorship,
  stats,
}: {
  exportedAt: string;
  sponsorship: SponsorReportPayload["sponsorship"];
  stats: SponsorReportStats;
}): SponsorReportPayload {
  return {
    exported_at: exportedAt,
    methodology: SPONSOR_REPORT_METHODOLOGY,
    note:
      "Totals use retained daily aggregates. Unique views and clicks cover the rolling 30-day pseudonymous measurement window. Raw viewer hashes and raw events are intentionally excluded.",
    report_status: SPONSOR_REPORT_STATUS,
    sponsorship: {
      cycle_number: sponsorship.cycle_number,
      sponsor_name: sponsorship.sponsor_name,
      is_active: sponsorship.is_active,
      starts_at: sponsorship.starts_at,
      ends_at: sponsorship.ends_at,
      created_at: sponsorship.created_at,
      updated_at: sponsorship.updated_at,
    },
    totals: {
      impressions: stats.impressions,
      unique_views: stats.uniqueViews,
      clicks: stats.clicks,
      unique_clicks: stats.uniqueClicks,
      ctr_percent: Number(stats.ctr.toFixed(2)),
    },
    daily: stats.dailyStats.map((daily) => ({
      date: daily.date,
      impressions: daily.impressions,
      clicks: daily.clicks,
      ctr_percent: Number(daily.ctrPercent.toFixed(2)),
    })),
    surfaces: serializeSponsorSurfaceStats(stats).map((surfaceStats) => ({
      surface: surfaceStats.surface,
      label: surfaceStats.label,
      impressions: surfaceStats.impressions,
      unique_views: surfaceStats.uniqueViews,
      clicks: surfaceStats.clicks,
      unique_clicks: surfaceStats.uniqueClicks,
      ctr_percent: Number(
        getCtrPercent(
          surfaceStats.clicks,
          surfaceStats.impressions
        ).toFixed(2)
      ),
    })),
  };
}
