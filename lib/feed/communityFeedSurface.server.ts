import "server-only";

import type {
  CommunityFeedKind,
  CommunityFeedPage,
} from "@/lib/feed/communityFeed";
import {
  getCommunityFeedPage,
  resolveCommunityFeedAnchor,
} from "@/lib/feed/communityFeedReadModel.server";

function resetStateForAnchorStatus(
  status: "unavailable" | "context_unavailable"
): CommunityFeedPage["cursorState"] {
  return status === "context_unavailable"
    ? "context_unavailable_reset"
    : "anchor_unavailable_reset";
}

export async function getCommunityFeedSurfacePage({
  feed,
  cursor,
  anchorSubmissionId,
  cycleNumber = null,
}: {
  feed: CommunityFeedKind;
  cursor?: string | null;
  anchorSubmissionId?: number | null;
  cycleNumber?: number | null;
}): Promise<CommunityFeedPage> {
  if (cursor && anchorSubmissionId) {
    throw new Error("COMMUNITY_FEED_SURFACE_INPUT_INVALID");
  }

  if (!anchorSubmissionId) {
    return getCommunityFeedPage({ feed, cursor, cycleNumber });
  }

  const resolution = await resolveCommunityFeedAnchor({
    feed,
    submissionId: anchorSubmissionId,
    cycleNumber,
  });

  if (resolution.status !== "resolved") {
    const startPage = await getCommunityFeedPage({ feed, cycleNumber });
    return {
      ...startPage,
      cursorState: resetStateForAnchorStatus(resolution.status),
    };
  }

  if (!resolution.item || !resolution.resumeCursor) {
    throw new Error("COMMUNITY_FEED_RESOLUTION_INVALID");
  }

  const continuedPage = await getCommunityFeedPage({
    feed,
    cursor: resolution.resumeCursor,
    cycleNumber,
  });

  if (continuedPage.cursorState !== "continued") {
    return continuedPage;
  }

  return {
    ...continuedPage,
    items: [
      resolution.item,
      ...continuedPage.items.filter(
        (item) => item.submissionId !== resolution.item?.submissionId
      ),
    ],
  };
}
