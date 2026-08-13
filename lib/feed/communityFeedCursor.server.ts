import "server-only";

import {
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  type PublicPaginationCursorPayload,
  type PublicPaginationScope,
} from "@/lib/pagination/publicPagination";
import {
  decodeServerPublicPaginationCursor,
  decodeServerPublicPaginationCursorForScope,
  encodeServerPublicPaginationCursor,
} from "@/lib/pagination/publicPaginationCursor.server";
import {
  COMMUNITY_FEED_CLASSIFICATION_VERSION,
  type CommunityFeedKind,
  type FinalizedCommunityFeedKind,
  type FinalizedFeedCursorTuple,
  type LiveFeedCursorTuple,
} from "@/lib/feed/communityFeed";

const FINALIZED_SCOPE_BY_FEED = {
  top10: PUBLIC_PAGINATION_SCOPES.feedTop10,
  all: PUBLIC_PAGINATION_SCOPES.feedAll,
  trash: PUBLIC_PAGINATION_SCOPES.feedTrash,
} as const satisfies Record<
  FinalizedCommunityFeedKind,
  PublicPaginationScope
>;

export function getCommunityFeedCursorScope(
  feed: CommunityFeedKind
) {
  return feed === "live"
    ? PUBLIC_PAGINATION_SCOPES.feedLive
    : FINALIZED_SCOPE_BY_FEED[feed];
}

export function encodeLiveFeedCursor({
  cycleId,
  resetCount,
  tuple,
}: {
  cycleId: number;
  resetCount: number;
  tuple: LiveFeedCursorTuple;
}) {
  return encodeServerPublicPaginationCursor({
    version: PUBLIC_PAGINATION_CURSOR_VERSION,
    scope: PUBLIC_PAGINATION_SCOPES.feedLive,
    context: { feed: "live", cycleId, resetCount },
    values: tuple,
  });
}

export function decodeLiveFeedCursor(
  cursor: string
) {
  return decodeServerPublicPaginationCursorForScope(
    cursor,
    PUBLIC_PAGINATION_SCOPES.feedLive
  ) as Extract<
    PublicPaginationCursorPayload,
    { scope: typeof PUBLIC_PAGINATION_SCOPES.feedLive }
  >;
}

export function encodeFinalizedFeedCursor({
  feed,
  tuple,
}: {
  feed: FinalizedCommunityFeedKind;
  tuple: FinalizedFeedCursorTuple;
}) {
  return encodeServerPublicPaginationCursor({
    version: PUBLIC_PAGINATION_CURSOR_VERSION,
    scope: FINALIZED_SCOPE_BY_FEED[feed],
    context: {
      feed,
      classificationVersion:
        COMMUNITY_FEED_CLASSIFICATION_VERSION,
    },
    values: tuple,
  } as PublicPaginationCursorPayload);
}

export function decodeFinalizedFeedCursor(
  cursor: string,
  feed: FinalizedCommunityFeedKind
) {
  return decodeServerPublicPaginationCursor(
    cursor,
    FINALIZED_SCOPE_BY_FEED[feed],
    {
      feed,
      classificationVersion:
        COMMUNITY_FEED_CLASSIFICATION_VERSION,
    }
  ) as Extract<
    PublicPaginationCursorPayload,
    {
      scope:
        | typeof PUBLIC_PAGINATION_SCOPES.feedTop10
        | typeof PUBLIC_PAGINATION_SCOPES.feedAll
        | typeof PUBLIC_PAGINATION_SCOPES.feedTrash;
    }
  >;
}
