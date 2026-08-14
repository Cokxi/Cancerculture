export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  getSponsorViewerHash,
  hasSponsorMeasurementConsent,
  isSponsorEventType,
  isSponsorTrackingSurface,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
  SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/sponsors/tracking";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const sponsorshipId = Number(body?.sponsorshipId);

  if (
    !Number.isInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !isSponsorEventType(body?.eventType) ||
    !isSponsorTrackingSurface(body?.surface) ||
    body?.surface === "spread"
  ) {
    return NextResponse.json(
      { error: "Invalid sponsor tracking event" },
      { status: 400 }
    );
  }

  if (!(await hasSponsorMeasurementConsent())) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { anonymousViewerId, viewerHash } =
    await getSponsorViewerHash();

  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } }
  );

  if (anonymousViewerId) {
    response.cookies.set(
      SPONSOR_TRACKING_COOKIE,
      anonymousViewerId,
      {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
        maxAge: SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
      }
    );
  }

  if (!viewerHash) {
    return response;
  }

  await recordSponsorEvent({
    eventType: body.eventType,
    sponsorshipId,
    surface: body.surface,
    viewerHash,
  });

  return response;
}
