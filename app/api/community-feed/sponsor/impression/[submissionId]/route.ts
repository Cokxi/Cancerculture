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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  const searchParams = new URL(request.url).searchParams;
  const feed = searchParams.get("feed");
  const cycleRaw = searchParams.get("cycle");
  const cycleNumber = cycleRaw === null ? null : Number(cycleRaw);
  const submissionId = Number((await params).submissionId);
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";

  if (
    !isCommunityFeedKind(feed) ||
    !Number.isSafeInteger(submissionId) ||
    submissionId <= 0 ||
    (cycleNumber !== null &&
      (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0)) ||
    (feed === "live" && cycleNumber !== null) ||
    !verifySponsorMeasurementToken({
      token,
      feed,
      submissionId,
      cycleNumber,
    }) ||
    !(await hasSponsorMeasurementConsent())
  ) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const sponsor = await resolveCommunityFeedSponsorSource({
    feed,
    submissionId,
    cycleNumber,
  });
  if (!sponsor) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { anonymousViewerId, viewerHash } = await getSponsorViewerHash();
  if (viewerHash) {
    await recordSponsorEvent({
      eventType: "impression",
      feedKind: feed,
      sponsorshipId: sponsor.sponsorshipId,
      surface: "spread",
      viewerHash,
    });
  }

  const response = new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
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
