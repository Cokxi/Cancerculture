export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import {
  getSponsorReportStats,
  serializeSponsorSurfaceStats,
  type SponsorTrackingAggregateForReport,
  type SponsorTrackingEventForReport,
} from "@/lib/sponsors/report";

function getSafeFilenamePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ cycleNumber: string }> }
) {
  try {
    await requireDynamicTeamCapability("sponsorships.reports.view");

    const cycleNumber = Number((await context.params).cycleNumber);
    if (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0) {
      return NextResponse.json(
        { error: "Invalid public Cycle number" },
        { status: 400 }
      );
    }

    const { data: cycle, error: cycleError } = await supabaseAdmin
      .from("voting_cycles")
      .select("id")
      .eq("public_number", cycleNumber)
      .limit(1)
      .maybeSingle();
    if (cycleError || !cycle) {
      return NextResponse.json(
        { error: "Sponsored Cycle not found" },
        { status: 404 }
      );
    }

    const { data: sponsorship, error: sponsorshipError } = await supabaseAdmin
      .from("cycle_sponsorships")
      .select(
        "id, sponsor_name, sponsor_link, is_active, starts_at, ends_at, created_at, updated_at"
      )
      .eq("cycle_id", cycle.id)
      .limit(1)
      .maybeSingle();

    if (sponsorshipError || !sponsorship) {
      return NextResponse.json(
        { error: "Sponsorship not found" },
        { status: 404 }
      );
    }

    const sponsorshipId = Number(sponsorship.id);
    if (!Number.isSafeInteger(sponsorshipId) || sponsorshipId <= 0) {
      return NextResponse.json(
        { error: "Sponsorship not found" },
        { status: 404 }
      );
    }

    const [eventsResult, aggregatesResult] = await Promise.all([
      supabaseAdmin
        .from("sponsor_tracking_events")
        .select(
          "event_type, surface, feed_kind, viewer_hash, measurement_window_start, created_at"
        )
        .eq("sponsorship_id", sponsorshipId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("sponsor_tracking_aggregates")
        .select("event_type, surface, feed_kind, event_count")
        .eq("sponsorship_id", sponsorshipId),
    ]);

    if (eventsResult.error || aggregatesResult.error) {
      return NextResponse.json(
        { error: "Failed to load sponsor tracking events" },
        { status: 500 }
      );
    }

    const stats = getSponsorReportStats(
      (eventsResult.data ?? []) as SponsorTrackingEventForReport[],
      (aggregatesResult.data ?? []) as SponsorTrackingAggregateForReport[]
    );
    const exportPayload = {
      exported_at: new Date().toISOString(),
      note:
        "Totals use retained daily aggregates. Unique views and clicks cover the rolling 30-day pseudonymous raw-data window. Raw viewer hashes are intentionally not included in this export.",
      sponsorship: {
        cycle_number: cycleNumber,
        sponsor_name: sponsorship.sponsor_name,
        sponsor_link: sponsorship.sponsor_link,
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
      surfaces: serializeSponsorSurfaceStats(stats).map((surfaceStats) => ({
        surface: surfaceStats.surface,
        impressions: surfaceStats.impressions,
        unique_views: surfaceStats.uniqueViews,
        clicks: surfaceStats.clicks,
        unique_clicks: surfaceStats.uniqueClicks,
      })),
    };

    const sponsorPart =
      getSafeFilenamePart(sponsorship.sponsor_name) || "sponsor";
    const filename = `sponsor-report-cycle-${cycleNumber}-${sponsorPart}.json`;

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
