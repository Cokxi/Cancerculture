import type { PublicPage } from "@/lib/pagination/publicPagination";

export const COMMUNITY_FEED_CLASSIFICATION_VERSION = 1;

export const COMMUNITY_FEEDS = {
  live: "live",
  top10: "top10",
  all: "all",
  trash: "trash",
} as const;

export type CommunityFeedKind =
  (typeof COMMUNITY_FEEDS)[keyof typeof COMMUNITY_FEEDS];

export type FinalizedCommunityFeedKind = Exclude<
  CommunityFeedKind,
  "live"
>;

export type CommunityFeedItem = {
  submissionId: number;
  cycleNumber: number;
  imageUrl: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  createdAt: string;
  finalizedAt: string | null;
  finalVoteCount: number | null;
  rankInCycle: number | null;
};

export type CommunityFeedContext =
  | {
      kind: "live";
      cycleId: number;
      cycleNumber: number;
      resetCount: number;
    }
  | {
      kind: "finalized";
      classificationVersion: number;
    };

export type CommunityFeedCursorState =
  | "start"
  | "continued"
  | "anchor_unavailable_reset"
  | "context_unavailable_reset";

export type CommunityFeedPage = PublicPage<CommunityFeedItem> & {
  feed: CommunityFeedKind;
  context: CommunityFeedContext | null;
  cursorState: CommunityFeedCursorState;
};

export type CommunityFeedAnchorResolution = {
  feed: CommunityFeedKind;
  submissionId: number;
  status: "resolved" | "unavailable" | "context_unavailable";
  context: CommunityFeedContext | null;
  item: CommunityFeedItem | null;
  resumeCursor: string | null;
};

export type LiveFeedCursorTuple = {
  createdAt: string;
  submissionId: number;
};

export type FinalizedFeedCursorTuple = {
  finalizedAt: string;
  cycleId: number;
  rankInCycle: number;
  submissionId: number;
};

export function getLiveFeedKeysetFilter({
  createdAt,
  submissionId,
}: LiveFeedCursorTuple) {
  return [
    `created_at.lt.${createdAt}`,
    `and(created_at.eq.${createdAt},id.lt.${submissionId})`,
  ].join(",");
}

export function getFinalizedFeedKeysetFilter({
  finalizedAt,
  cycleId,
  rankInCycle,
  submissionId,
}: FinalizedFeedCursorTuple) {
  return [
    `finalized_at.lt.${finalizedAt}`,
    `and(finalized_at.eq.${finalizedAt},cycle_id.lt.${cycleId})`,
    `and(finalized_at.eq.${finalizedAt},cycle_id.eq.${cycleId},rank_in_cycle.gt.${rankInCycle})`,
    `and(finalized_at.eq.${finalizedAt},cycle_id.eq.${cycleId},rank_in_cycle.eq.${rankInCycle},submission_id.gt.${submissionId})`,
  ].join(",");
}

export function canonicalFeedTimestamp(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("COMMUNITY_FEED_TIMESTAMP_INVALID");
  }

  return parsed.toISOString();
}
