import type {
  SponsorEventType,
  SponsorTrackingSurface,
} from "@/lib/sponsors/tracking";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";

export type SponsorReportSurfaceKey =
  | SponsorTrackingSurface
  | `spread:${CommunityFeedKind}`;

export type SponsorTrackingEventForReport = {
  event_type: SponsorEventType;
  surface: SponsorTrackingSurface;
  viewer_hash: string;
  feed_kind?: CommunityFeedKind | null;
  measurement_window_start?: string | null;
  created_at?: string;
};

export type SponsorTrackingAggregateForReport = {
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

export type SponsorReportStats = {
  clicks: number;
  ctr: number;
  impressions: number;
  surfaceStats: Map<SponsorReportSurfaceKey, SponsorSurfaceReport>;
  uniqueClicks: number;
  uniqueViews: number;
};

export function getSponsorReportStats(
  events: SponsorTrackingEventForReport[],
  aggregates?: SponsorTrackingAggregateForReport[]
): SponsorReportStats {
  const impressions = events.filter(
    (event) => event.event_type === "impression"
  );
  const clicks = events.filter(
    (event) => event.event_type === "click"
  );
  const surfaceStats = new Map<
    SponsorReportSurfaceKey,
    {
      clicks: number;
      impressions: number;
      uniqueClicks: Set<string>;
      uniqueViews: Set<string>;
    }
  >();

  const surfaceKey = (
    surface: SponsorTrackingSurface,
    feedKind: CommunityFeedKind | null | undefined
  ): SponsorReportSurfaceKey =>
    surface === "spread" && feedKind
      ? `spread:${feedKind}`
      : surface;

  if (aggregates) {
    for (const aggregate of aggregates) {
      const key = surfaceKey(aggregate.surface, aggregate.feed_kind);
      const current = surfaceStats.get(key) ?? {
        clicks: 0,
        impressions: 0,
        uniqueClicks: new Set<string>(),
        uniqueViews: new Set<string>(),
      };
      if (aggregate.event_type === "impression") {
        current.impressions += aggregate.event_count;
      } else {
        current.clicks += aggregate.event_count;
      }
      surfaceStats.set(key, current);
    }
  }

  for (const event of events) {
    const key = surfaceKey(event.surface, event.feed_kind);
    const current =
      surfaceStats.get(key) ?? {
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

  const aggregateImpressions = aggregates?.filter(
    (aggregate) => aggregate.event_type === "impression"
  ).reduce((sum, aggregate) => sum + aggregate.event_count, 0);
  const aggregateClicks = aggregates?.filter(
    (aggregate) => aggregate.event_type === "click"
  ).reduce((sum, aggregate) => sum + aggregate.event_count, 0);
  const impressionCount = aggregateImpressions ?? impressions.length;
  const clickCount = aggregateClicks ?? clicks.length;

  return {
    clicks: clickCount,
    ctr:
      impressionCount > 0
        ? (clickCount / impressionCount) * 100
        : 0,
    impressions: impressionCount,
    surfaceStats: new Map(
      Array.from(surfaceStats.entries()).map(
        ([surface, stats]) => [
          surface,
          {
            clicks: stats.clicks,
            impressions: stats.impressions,
            uniqueClicks: stats.uniqueClicks.size,
            uniqueViews: stats.uniqueViews.size,
          },
        ]
      )
    ),
    uniqueClicks: new Set(
      clicks.map((event) => event.viewer_hash)
    ).size,
    uniqueViews: new Set(
      impressions.map((event) => event.viewer_hash)
    ).size,
  };
}

export function serializeSponsorSurfaceStats(
  stats: SponsorReportStats
) {
  return Array.from(stats.surfaceStats.entries()).map(
    ([surface, surfaceStats]) => ({
      surface,
      ...surfaceStats,
    })
  );
}
