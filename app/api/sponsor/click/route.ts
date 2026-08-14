export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getCycleSponsorshipById } from "@/lib/cycles/sponsoredCycle";
import {
  getSponsorViewerHash,
  hasSponsorMeasurementConsent,
  isSponsorTrackingSurface,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
  SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/sponsors/tracking";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sponsorshipId = Number(url.searchParams.get("sponsorshipId"));
  const surface = url.searchParams.get("surface");

  if (
    !Number.isInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !isSponsorTrackingSurface(surface) ||
    surface === "spread"
  ) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const sponsorship = await getCycleSponsorshipById(sponsorshipId);

  if (!sponsorship?.sponsorLink) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const consented = await hasSponsorMeasurementConsent();
  const { anonymousViewerId, viewerHash } = consented
    ? await getSponsorViewerHash()
    : { anonymousViewerId: null, viewerHash: null };

  if (viewerHash) {
    await recordSponsorEvent({
      eventType: "click",
      sponsorshipId,
      surface,
      viewerHash,
    });
  }

  const response = NextResponse.redirect(sponsorship.sponsorLink);

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

  return response;
}
