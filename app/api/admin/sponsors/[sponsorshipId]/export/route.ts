export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import {
  getSponsorReportStats,
  serializeSponsorSurfaceStats,
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
  context: {
    params: Promise<{ sponsorshipId: string }>;
  }
) {
  try {
    const authorization = await requireDynamicTeamCapability(
      "sponsorships.reports.view"
    );

    const { sponsorshipId: sponsorshipIdRaw } =
      await context.params;
    const sponsorshipId = Number(sponsorshipIdRaw);

    if (
      !Number.isInteger(sponsorshipId) ||
      sponsorshipId <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid sponsorship id" },
        { status: 400 }
      );
    }

    const { data: sponsorship, error: sponsorshipError } =
      await supabaseAdmin
        .from("cycle_sponsorships")
        .select(
          "id, cycle_id, sponsor_name, sponsor_link, banner_r2_key, is_active, starts_at, ends_at, created_at, updated_at"
        )
        .eq("id", sponsorshipId)
        .maybeSingle();

    if (sponsorshipError || !sponsorship) {
      return NextResponse.json(
        { error: "Sponsorship not found" },
        { status: 404 }
      );
    }

    const { data: events, error: eventsError } =
      await supabaseAdmin
        .from("sponsor_tracking_events")
        .select("event_type, surface, viewer_hash, created_at")
        .eq("sponsorship_id", sponsorshipId)
        .order("created_at", { ascending: true });

    if (eventsError) {
      return NextResponse.json(
        { error: "Failed to load sponsor tracking events" },
        { status: 500 }
      );
    }

    const stats = getSponsorReportStats(
      (events ?? []) as SponsorTrackingEventForReport[]
    );
    const exportPayload = {
      exported_at: new Date().toISOString(),
      note:
        "Unique views and clicks are counted from pseudonymous viewer hashes with the configured cooldown window. Raw viewer hashes are intentionally not included in this export.",
      sponsorship: {
        id: sponsorship.id,
        cycle_id: sponsorship.cycle_id,
        sponsor_name: sponsorship.sponsor_name,
        sponsor_link: sponsorship.sponsor_link,
        ...(authorization.isAdmin
          ? { banner_r2_key: sponsorship.banner_r2_key }
          : {}),
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
      surfaces: serializeSponsorSurfaceStats(stats).map(
        (surfaceStats) => ({
          surface: surfaceStats.surface,
          impressions: surfaceStats.impressions,
          unique_views: surfaceStats.uniqueViews,
          clicks: surfaceStats.clicks,
          unique_clicks: surfaceStats.uniqueClicks,
        })
      ),
    };

    const sponsorPart =
      getSafeFilenamePart(sponsorship.sponsor_name) ||
      "sponsor";
    const filename = `sponsor-report-cycle-${sponsorship.cycle_id}-${sponsorPart}.json`;

    return new NextResponse(
      JSON.stringify(exportPayload, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
