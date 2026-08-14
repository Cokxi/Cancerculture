export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { resolveCommunityFeedDetailMediaSource } from "@/lib/feed/communityFeedDetail.server";
import {
  createNeutralCommunityFeedMediaResponse,
  proxyCommunityFeedMedia,
} from "@/lib/feed/communityFeedMedia";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ submissionId: string }> }
) {
  try {
    const submissionId = Number((await params).submissionId);
    if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const source = await resolveCommunityFeedDetailMediaSource(submissionId);
    return source
      ? proxyCommunityFeedMedia({ storageKey: source.r2Key })
      : createNeutralCommunityFeedMediaResponse();
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
