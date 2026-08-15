export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getCycleSponsorshipSourceById } from "@/lib/cycles/sponsoredCycle";
import {
  createNeutralCommunityFeedMediaResponse,
  proxyCommunityFeedMedia,
} from "@/lib/feed/communityFeedMedia";
import { verifySponsorPresentationGrant } from "@/lib/sponsors/presentationToken.server";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const grant = verifySponsorPresentationGrant({
      token: url.searchParams.get("token") ?? "",
      surface: url.searchParams.get("surface"),
    });
    if (!grant) return createNeutralCommunityFeedMediaResponse();
    const source = await getCycleSponsorshipSourceById(grant.sponsorshipId);
    if (!source) return createNeutralCommunityFeedMediaResponse();
    if (grant.surface === "spread_detail") {
      return source.feedBannerR2Key
        ? proxyCommunityFeedMedia({
            storageKey: source.feedBannerR2Key,
            expectedDimensions: { width: 1800, height: 300 },
          })
        : createNeutralCommunityFeedMediaResponse();
    }
    return proxyCommunityFeedMedia({
      storageKey: source.detailBannerR2Key,
      expectedDimensions: { width: 1200, height: 600 },
    });
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
