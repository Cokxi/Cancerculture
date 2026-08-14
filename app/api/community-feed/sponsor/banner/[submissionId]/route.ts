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
    const feed = new URL(request.url).searchParams.get("feed");
    const submissionId = Number((await params).submissionId);
    if (
      !isCommunityFeedKind(feed) ||
      !Number.isSafeInteger(submissionId) ||
      submissionId <= 0
    ) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const sponsor = await resolveCommunityFeedSponsorSource({ feed, submissionId });
    return sponsor
      ? proxyCommunityFeedMedia({ storageKey: sponsor.bannerR2Key })
      : createNeutralCommunityFeedMediaResponse();
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
