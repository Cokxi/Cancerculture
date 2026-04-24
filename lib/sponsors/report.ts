import type {
  SponsorEventType,
  SponsorTrackingSurface,
} from "@/lib/sponsors/tracking";

export type SponsorTrackingEventForReport = {
  event_type: SponsorEventType;
  surface: SponsorTrackingSurface;
  viewer_hash: string;
  created_at?: string;
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
  surfaceStats: Map<SponsorTrackingSurface, SponsorSurfaceReport>;
  uniqueClicks: number;
  uniqueViews: number;
};

export function getSponsorReportStats(
  events: SponsorTrackingEventForReport[]
): SponsorReportStats {
  const impressions = events.filter(
    (event) => event.event_type === "impression"
  );
  const clicks = events.filter(
    (event) => event.event_type === "click"
  );
  const surfaceStats = new Map<
    SponsorTrackingSurface,
    {
      clicks: number;
      impressions: number;
      uniqueClicks: Set<string>;
      uniqueViews: Set<string>;
    }
  >();

  for (const event of events) {
    const current =
      surfaceStats.get(event.surface) ?? {
        clicks: 0,
        impressions: 0,
        uniqueClicks: new Set<string>(),
        uniqueViews: new Set<string>(),
      };

    if (event.event_type === "impression") {
      current.impressions += 1;
      current.uniqueViews.add(event.viewer_hash);
    } else {
      current.clicks += 1;
      current.uniqueClicks.add(event.viewer_hash);
    }

    surfaceStats.set(event.surface, current);
  }

  return {
    clicks: clicks.length,
    ctr:
      impressions.length > 0
        ? (clicks.length / impressions.length) * 100
        : 0,
    impressions: impressions.length,
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
