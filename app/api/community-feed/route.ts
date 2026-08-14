export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";
import { getCommunityFeedSurfacePage } from "@/lib/feed/communityFeedSurface.server";
import {
  isCommunityFeedKind,
  parseCommunityFeedCycleNumber,
} from "@/lib/feed/communityFeedSurface";

function invalidRequest(error: string) {
  return NextResponse.json(
    { error },
    {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const feed = params.get("feed");
    const cursor = params.get("cursor");
    const rawAnchor = params.get("anchor");
    const rawCycle = params.get("cycle");

    if (!isCommunityFeedKind(feed)) {
      return invalidRequest("INVALID_FEED");
    }

    if (cursor && rawAnchor) {
      return invalidRequest("AMBIGUOUS_POSITION");
    }

    let cycleNumber: number | null = null;
    if (rawCycle !== null) {
      cycleNumber = parseCommunityFeedCycleNumber(rawCycle);
      if (
        feed === "live" ||
        cycleNumber === null
      ) {
        return invalidRequest("INVALID_CYCLE_FILTER");
      }
    }

    let anchorSubmissionId: number | null = null;
    if (rawAnchor !== null) {
      anchorSubmissionId = Number(rawAnchor);
      if (
        !Number.isSafeInteger(anchorSubmissionId) ||
        anchorSubmissionId <= 0
      ) {
        return invalidRequest("INVALID_ANCHOR");
      }
    }

    const page = await getCommunityFeedSurfacePage({
      feed,
      cursor,
      anchorSubmissionId,
      cycleNumber,
    });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}
