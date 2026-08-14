import {
  COMMUNITY_FEEDS,
  getCommunityFeedMediaPath,
  type CommunityFeedContext,
  type CommunityFeedItem,
  type CommunityFeedKind,
  type CommunityFeedPage,
} from "@/lib/feed/communityFeed";

export const COMMUNITY_FEED_LABELS = {
  live: "Live",
  top10: "Top 10",
  all: "All",
  trash: "Trash",
} as const satisfies Record<CommunityFeedKind, string>;

export const COMMUNITY_FEED_DESCRIPTIONS = {
  live: "Newest public submissions from the current Cycle.",
  top10: "Positive-vote finalists ranked in the Top 10, including ties.",
  all: "Positive-vote finalists outside the Cycle-relative Trash group.",
  trash: "The stored tie-safe lower 10 percent from finalized Cycles.",
} as const satisfies Record<CommunityFeedKind, string>;

const FEED_VALUES = Object.values(COMMUNITY_FEEDS);
const PAGE_KEYS = [
  "context",
  "cursorState",
  "feed",
  "hasMore",
  "items",
  "nextCursor",
] as const;
const ITEM_KEYS = [
  "createdAt",
  "cycleNumber",
  "finalVoteCount",
  "finalizedAt",
  "imageUrl",
  "mediaHeight",
  "mediaWidth",
  "rankInCycle",
  "submissionId",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isNullableFeedMediaPath(
  value: unknown,
  feed: CommunityFeedKind,
  submissionId: number
): value is string | null {
  if (value === null) return true;
  return value === getCommunityFeedMediaPath(feed, submissionId);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isCommunityFeedItem(
  value: unknown,
  feed: CommunityFeedKind
): value is CommunityFeedItem {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) return false;

  return (
    isPositiveInteger(value.submissionId) &&
    isPositiveInteger(value.cycleNumber) &&
    isNullableFeedMediaPath(value.imageUrl, feed, value.submissionId) &&
    isNullablePositiveInteger(value.mediaWidth) &&
    isNullablePositiveInteger(value.mediaHeight) &&
    ((value.mediaWidth === null && value.mediaHeight === null) ||
      (isPositiveInteger(value.mediaWidth) &&
        isPositiveInteger(value.mediaHeight))) &&
    isTimestamp(value.createdAt) &&
    isNullableTimestamp(value.finalizedAt) &&
    isNullablePositiveInteger(value.finalVoteCount) &&
    isNullablePositiveInteger(value.rankInCycle)
  );
}

function isCommunityFeedContext(
  value: unknown
): value is CommunityFeedContext | null {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  if (value.kind === "live") {
    return (
      hasExactKeys(value, [
        "cycleId",
        "cycleNumber",
        "kind",
        "resetCount",
      ]) &&
      isPositiveInteger(value.cycleId) &&
      isPositiveInteger(value.cycleNumber) &&
      isNonNegativeInteger(value.resetCount)
    );
  }

  return (
    value.kind === "finalized" &&
    hasExactKeys(value, ["classificationVersion", "kind"]) &&
    isPositiveInteger(value.classificationVersion)
  );
}

export function isCommunityFeedKind(
  value: unknown
): value is CommunityFeedKind {
  return FEED_VALUES.includes(value as CommunityFeedKind);
}

export function isCommunityFeedPage(
  value: unknown
): value is CommunityFeedPage {
  if (!isRecord(value) || !hasExactKeys(value, PAGE_KEYS)) return false;
  if (!isCommunityFeedKind(value.feed)) return false;
  const feed = value.feed;

  const baseValid =
    Array.isArray(value.items) &&
    value.items.every((item) => isCommunityFeedItem(item, feed)) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0)) &&
    typeof value.hasMore === "boolean" &&
    isCommunityFeedContext(value.context) &&
    (value.cursorState === "start" ||
      value.cursorState === "continued" ||
      value.cursorState === "anchor_unavailable_reset" ||
      value.cursorState === "context_unavailable_reset");

  if (!baseValid) return false;
  const page = value as CommunityFeedPage;

  if (page.feed === "live") {
    return (
      (page.context === null || page.context.kind === "live") &&
      page.items.every(
        (item) =>
          item.finalizedAt === null &&
          item.finalVoteCount === null &&
          item.rankInCycle === null
      )
    );
  }

  return (
    page.context !== null &&
    page.context.kind === "finalized" &&
    page.items.every(
      (item) =>
        item.finalizedAt !== null &&
        item.finalVoteCount !== null &&
        item.rankInCycle !== null
    )
  );
}

export function mergeCommunityFeedItems(
  current: CommunityFeedItem[],
  incoming: CommunityFeedItem[]
) {
  const seen = new Set(current.map((item) => item.submissionId));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (seen.has(item.submissionId)) return false;
      seen.add(item.submissionId);
      return true;
    }),
  ];
}

export function getCommunityFeedHref(
  feed: CommunityFeedKind,
  submissionId?: number
) {
  const params = new URLSearchParams({ feed });
  if (submissionId && Number.isSafeInteger(submissionId)) {
    params.set("submission", String(submissionId));
  }
  return `/spread?${params.toString()}`;
}
