export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getCycleSponsorshipById } from "@/lib/cycles/sponsoredCycle";
import {
  getSponsorViewerHash,
  isSponsorTrackingSurface,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
} from "@/lib/sponsors/tracking";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sponsorshipId = Number(url.searchParams.get("sponsorshipId"));
  const surface = url.searchParams.get("surface");

  if (
    !Number.isInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !isSponsorTrackingSurface(surface)
  ) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const sponsorship = await getCycleSponsorshipById(sponsorshipId);

  if (!sponsorship?.sponsorLink) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const { anonymousViewerId, viewerHash } =
    await getSponsorViewerHash();

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
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 180,
      }
    );
  }

  return response;
}
