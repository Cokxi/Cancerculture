export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import {
  buildSponsorReportPayload,
  getSponsorReportStats,
  type SponsorTrackingAggregateForReport,
  type SponsorTrackingEventForReport,
} from "@/lib/sponsors/report";
import { createSponsorReportPdf } from "@/lib/sponsors/reportPdf";

function getSafeFilenamePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ cycleNumber: string }> }
) {
  try {
    await requireDynamicTeamCapability("sponsorships.reports.view");

    const format = new URL(request.url).searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "pdf") {
      return NextResponse.json(
        { error: "Unsupported Sponsor report format" },
        { status: 400 }
      );
    }

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
        "id, sponsor_name, is_active, starts_at, ends_at, created_at, updated_at"
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

    const exportedAt = new Date().toISOString();
    const rollingUniqueWindowStart = new Date(
      Date.parse(exportedAt) - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    const [eventsResult, aggregatesResult] = await Promise.all([
      supabaseAdmin
        .from("sponsor_tracking_events")
        .select("event_type, surface, feed_kind, viewer_hash, created_at")
        .eq("sponsorship_id", sponsorshipId)
        .gte("created_at", rollingUniqueWindowStart)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("sponsor_tracking_aggregates")
        .select("event_day, event_type, surface, feed_kind, event_count")
        .eq("sponsorship_id", sponsorshipId)
        .order("event_day", { ascending: true }),
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
    const exportPayload = buildSponsorReportPayload({
      exportedAt,
      sponsorship: {
        cycle_number: cycleNumber,
        sponsor_name: sponsorship.sponsor_name,
        is_active: sponsorship.is_active,
        starts_at: sponsorship.starts_at,
        ends_at: sponsorship.ends_at,
        created_at: sponsorship.created_at,
        updated_at: sponsorship.updated_at,
      },
      stats,
    });

    const sponsorPart =
      getSafeFilenamePart(sponsorship.sponsor_name) || "sponsor";
    const filenameBase = `sponsor-report-cycle-${cycleNumber}-${sponsorPart}`;

    if (format === "pdf") {
      const pdf = await createSponsorReportPdf(exportPayload);
      return new NextResponse(Buffer.from(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenameBase}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
