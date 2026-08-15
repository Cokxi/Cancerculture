export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isCommunityFeedKind } from "@/lib/feed/communityFeedSurface";
import { resolveCommunityFeedSponsorSource } from "@/lib/feed/communityFeedSponsor.server";
import {
  getSponsorViewerHash,
  hasSponsorMeasurementConsent,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
  SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/sponsors/tracking";
import { verifySponsorMeasurementToken } from "@/lib/sponsors/measurementToken.server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  const url = new URL(request.url);
  const feed = url.searchParams.get("feed");
  const cycleRaw = url.searchParams.get("cycle");
  const cycleNumber = cycleRaw === null ? null : Number(cycleRaw);
  const token = url.searchParams.get("token") ?? "";
  const submissionId = Number((await params).submissionId);
  if (
    !isCommunityFeedKind(feed) ||
    !Number.isSafeInteger(submissionId) ||
    submissionId <= 0 ||
    (cycleNumber !== null &&
      (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0)) ||
    (feed === "live" && cycleNumber !== null)
  ) {
    return NextResponse.redirect(new URL("/spread", request.url));
  }

  const sponsor = await resolveCommunityFeedSponsorSource({
    feed,
    submissionId,
    cycleNumber,
  });
  if (!sponsor) return NextResponse.redirect(new URL("/spread", request.url));

  let anonymousViewerId: string | null = null;
  if (
    verifySponsorMeasurementToken({
      token,
      feed,
      submissionId,
      cycleNumber,
    }) &&
    (await hasSponsorMeasurementConsent())
  ) {
    const viewer = await getSponsorViewerHash();
    anonymousViewerId = viewer.anonymousViewerId;
    if (viewer.viewerHash) {
      await recordSponsorEvent({
        eventType: "click",
        feedKind: feed,
        sponsorshipId: sponsor.sponsorshipId,
        surface: "spread",
        viewerHash: viewer.viewerHash,
      });
    }
  }

  const response = NextResponse.redirect(sponsor.targetUrl);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (anonymousViewerId) {
    response.cookies.set(SPONSOR_TRACKING_COOKIE, anonymousViewerId, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}
