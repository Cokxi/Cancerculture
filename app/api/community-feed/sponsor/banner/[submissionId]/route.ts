export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { isCommunityFeedKind } from "@/lib/feed/communityFeedSurface";
import { resolveCommunityFeedSponsorSource } from "@/lib/feed/communityFeedSponsor.server";
import {
  createNeutralCommunityFeedMediaResponse,
  proxyCommunityFeedMedia,
} from "@/lib/feed/communityFeedMedia";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const feed = searchParams.get("feed");
    const cycleRaw = searchParams.get("cycle");
    const cycleNumber = cycleRaw === null ? null : Number(cycleRaw);
    const submissionId = Number((await params).submissionId);
    if (
      !isCommunityFeedKind(feed) ||
      !Number.isSafeInteger(submissionId) ||
      submissionId <= 0 ||
      (cycleNumber !== null &&
        (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0)) ||
      (feed === "live" && cycleNumber !== null)
    ) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const sponsor = await resolveCommunityFeedSponsorSource({
      feed,
      submissionId,
      cycleNumber,
    });
    return sponsor
      ? proxyCommunityFeedMedia({
          storageKey: sponsor.feedBannerR2Key,
          expectedDimensions: { width: 1800, height: 300 },
        })
      : createNeutralCommunityFeedMediaResponse();
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
