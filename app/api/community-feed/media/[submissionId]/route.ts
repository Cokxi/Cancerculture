export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  isCommunityFeedKind,
  parseCommunityFeedCycleNumber,
} from "@/lib/feed/communityFeedSurface";
import { resolveCommunityFeedMediaSource } from "@/lib/feed/communityFeedReadModel.server";
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
    const rawCycle = new URL(request.url).searchParams.get("cycle");
    const { submissionId: rawSubmissionId } = await params;
    const submissionId = Number(rawSubmissionId);

    if (
      !isCommunityFeedKind(feed) ||
      !Number.isSafeInteger(submissionId) ||
      submissionId <= 0
    ) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const cycleNumber =
      rawCycle === null ? null : parseCommunityFeedCycleNumber(rawCycle);
    if (
      (feed === "live" && rawCycle !== null) ||
      (rawCycle !== null && cycleNumber === null)
    ) {
      return createNeutralCommunityFeedMediaResponse();
    }

    const source = await resolveCommunityFeedMediaSource({
      feed,
      submissionId,
      cycleNumber,
    });
    if (!source) return createNeutralCommunityFeedMediaResponse();

    return proxyCommunityFeedMedia({ storageKey: source.r2Key });
  } catch {
    return createNeutralCommunityFeedMediaResponse();
  }
}
