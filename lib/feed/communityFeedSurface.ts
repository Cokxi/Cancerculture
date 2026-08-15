import {
  COMMUNITY_FEEDS,
  getCommunityFeedMediaPath,
  type CommunityFeedContext,
  type CommunityFeedCycleCatalogItem,
  type CommunityFeedCycleCatalogPage,
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
const CYCLE_CATALOG_PAGE_KEYS = [
  "hasMore",
  "items",
  "nextCursor",
  "totalCount",
] as const;
const CYCLE_CATALOG_ITEM_KEYS = ["cycleNumber", "endsAt", "startsAt"] as const;
const UTC_MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
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
  feed: CommunityFeedKind,
  cycleNumber: number | null
): value is CommunityFeedItem {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) return false;

  return (
    isPositiveInteger(value.submissionId) &&
    isPositiveInteger(value.cycleNumber) &&
    (value.imageUrl === null ||
      value.imageUrl ===
        getCommunityFeedMediaPath(feed, value.submissionId, cycleNumber)) &&
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
        "cycleNumber",
        "kind",
        "resetCount",
      ]) &&
      isPositiveInteger(value.cycleNumber) &&
      isNonNegativeInteger(value.resetCount)
    );
  }

  return (
    value.kind === "finalized" &&
    hasExactKeys(value, ["classificationVersion", "cycleNumber", "kind"]) &&
    isPositiveInteger(value.classificationVersion) &&
    (value.cycleNumber === null || isPositiveInteger(value.cycleNumber))
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
  if (!isCommunityFeedContext(value.context)) return false;
  const selectedCycleNumber =
    value.context?.kind === "finalized" ? value.context.cycleNumber : null;

  const baseValid =
    Array.isArray(value.items) &&
    value.items.every((item) =>
      isCommunityFeedItem(item, feed, selectedCycleNumber)
    ) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0)) &&
    typeof value.hasMore === "boolean" &&
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

export function isCommunityFeedCycleNumber(value: unknown): value is number {
  return isPositiveInteger(value);
}

export function parseCommunityFeedCycleNumber(value: string) {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const cycleNumber = Number(value);
  return isCommunityFeedCycleNumber(cycleNumber) ? cycleNumber : null;
}

export function isCommunityFeedCycleCatalogPage(
  value: unknown
): value is CommunityFeedCycleCatalogPage {
  return (
    isRecord(value) &&
    hasExactKeys(value, CYCLE_CATALOG_PAGE_KEYS) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isRecord(item) &&
        hasExactKeys(item, CYCLE_CATALOG_ITEM_KEYS) &&
        isPositiveInteger(item.cycleNumber) &&
        isTimestamp(item.startsAt) &&
        isTimestamp(item.endsAt)
    ) &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0)) &&
    typeof value.hasMore === "boolean" &&
    (value.totalCount === null ||
      (isNonNegativeInteger(value.totalCount) &&
        value.totalCount >= value.items.length))
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

export function mergeCommunityFeedCycleCatalogItems(
  current: CommunityFeedCycleCatalogItem[],
  incoming: CommunityFeedCycleCatalogItem[]
) {
  const seen = new Set(current.map((item) => item.cycleNumber));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (seen.has(item.cycleNumber)) return false;
      seen.add(item.cycleNumber);
      return true;
    }),
  ];
}

function utcDateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid community Feed Cycle date");
  }
  return {
    day: String(date.getUTCDate()).padStart(2, "0"),
    month: UTC_MONTH_LABELS[date.getUTCMonth()],
    year: date.getUTCFullYear(),
  };
}

export function formatCommunityFeedCycleDateRange(
  item: CommunityFeedCycleCatalogItem
) {
  const start = utcDateParts(item.startsAt);
  const end = utcDateParts(item.endsAt);

  if (start.year === end.year && start.month === end.month) {
    return `${start.day}\u2013${end.day} ${start.month} ${start.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${start.month}\u2013${end.day} ${end.month} ${start.year}`;
  }
  return `${start.day} ${start.month} ${start.year}\u2013${end.day} ${end.month} ${end.year}`;
}

export function groupCommunityFeedCyclesByNumberRange(
  items: CommunityFeedCycleCatalogItem[],
  rangeSize = 10
) {
  if (!Number.isSafeInteger(rangeSize) || rangeSize <= 0) {
    throw new TypeError("Invalid community Feed Cycle range size");
  }

  const groups = new Map<
    number,
    {
      rangeStart: number;
      rangeEnd: number;
      cycles: CommunityFeedCycleCatalogItem[];
    }
  >();
  for (const item of items) {
    const rangeStart =
      Math.floor((item.cycleNumber - 1) / rangeSize) * rangeSize + 1;
    const group = groups.get(rangeStart);
    if (group) group.cycles.push(item);
    else {
      groups.set(rangeStart, {
        rangeStart,
        rangeEnd: rangeStart + rangeSize - 1,
        cycles: [item],
      });
    }
  }
  return Array.from(groups.values());
}

export function getCommunityFeedHref(
  feed: CommunityFeedKind,
  submissionId?: number,
  cycleNumber: number | null = null
) {
  const params = new URLSearchParams({ feed });
  if (feed !== "live" && cycleNumber !== null) {
    if (!isCommunityFeedCycleNumber(cycleNumber)) {
      throw new TypeError("Invalid community Feed Cycle number");
    }
    params.set("cycle", String(cycleNumber));
  }
  if (submissionId && Number.isSafeInteger(submissionId)) {
    params.set("submission", String(submissionId));
  }
  return `/spread?${params.toString()}`;
}
