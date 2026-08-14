export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isCommunityFeedKind } from "@/lib/feed/communityFeedSurface";
import { getCommunityFeedSponsorPaths } from "@/lib/feed/communityFeedSponsor";
import { resolveCommunityFeedSponsorSource } from "@/lib/feed/communityFeedSponsor.server";
import { createSponsorMeasurementGrant } from "@/lib/sponsors/measurementToken.server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  const feed = new URL(request.url).searchParams.get("feed");
  const submissionId = Number((await params).submissionId);
  if (
    !isCommunityFeedKind(feed) ||
    !Number.isSafeInteger(submissionId) ||
    submissionId <= 0
  ) {
    return NextResponse.json({ sponsored: false }, { headers: NO_STORE_HEADERS });
  }

  try {
    const sponsor = await resolveCommunityFeedSponsorSource({ feed, submissionId });
    if (!sponsor) {
      return NextResponse.json({ sponsored: false }, { headers: NO_STORE_HEADERS });
    }

    const measurementGrant = createSponsorMeasurementGrant({ feed, submissionId });
    const measurementToken = measurementGrant?.token ?? null;
    return NextResponse.json(
      {
        sponsored: true,
        companyName: sponsor.companyName,
        measurementToken,
        measurementTokenExpiresAt: measurementGrant?.expiresAt ?? null,
        ...getCommunityFeedSponsorPaths(feed, submissionId, measurementToken),
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch {
    return NextResponse.json({ sponsored: false }, { headers: NO_STORE_HEADERS });
  }
}
