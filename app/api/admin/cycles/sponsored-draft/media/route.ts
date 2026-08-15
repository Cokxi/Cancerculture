export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getSponsoredCycleDraftInternal } from "@/lib/cycles/sponsoredCycle";
import {
  createNeutralCommunityFeedMediaResponse,
  proxyCommunityFeedMedia,
} from "@/lib/feed/communityFeedMedia";
import {
  isSponsorBannerRole,
  isSponsorDetailBannerKey,
  isSponsorFeedBannerKey,
} from "@/lib/sponsors/bannerMedia.server";

export async function GET(request: Request) {
  try {
    await requireDynamicTeamCapability("cycles.manage");
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const revision = Number(url.searchParams.get("revision"));
    if (!isSponsorBannerRole(role) || !Number.isSafeInteger(revision)) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const draft = await getSponsoredCycleDraftInternal();
    if (draft.revision !== revision) {
      return createNeutralCommunityFeedMediaResponse();
    }
    const storageKey =
      role === "detail" ? draft.detailBannerR2Key : draft.feedBannerR2Key;
    const valid =
      role === "detail"
        ? isSponsorDetailBannerKey(storageKey)
        : isSponsorFeedBannerKey(storageKey);
    return valid
      ? proxyCommunityFeedMedia({
          storageKey,
          expectedDimensions:
            role === "detail"
              ? { width: 1200, height: 600 }
              : { width: 1800, height: 300 },
        })
      : createNeutralCommunityFeedMediaResponse();
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
