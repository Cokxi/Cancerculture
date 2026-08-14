import type {
  CommunityFeedContext,
  CommunityFeedKind,
} from "@/lib/feed/communityFeed";
import { isCommunityFeedKind } from "@/lib/feed/communityFeedSurface";

export const COMMUNITY_FEED_RESUME_VERSION = 2;
export const COMMUNITY_FEED_VIEWPORT_THRESHOLD = 0.65;
export const COMMUNITY_FEED_VIEWPORT_DWELL_MS = 750;
export const COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS = 500;

const STORAGE_PREFIX = "cancerculture.community-feed.resume.v2";

export type CommunityFeedResumeRecord = {
  version: typeof COMMUNITY_FEED_RESUME_VERSION;
  feed: CommunityFeedKind;
  submissionId: number;
  viewedAt: string;
  context:
    | {
        kind: "live";
        cycleNumber: number;
        resetCount: number;
      }
    | {
        kind: "finalized";
        classificationVersion: number;
        cycleNumber: number | null;
      };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[]
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function getCommunityFeedResumeStorageKey(
  feed: CommunityFeedKind,
  cycleNumber: number | null = null
) {
  if (feed === "live") {
    if (cycleNumber !== null) throw new Error("COMMUNITY_FEED_RESUME_KEY_INVALID");
    return `${STORAGE_PREFIX}.live`;
  }
  if (cycleNumber !== null && !isPositiveInteger(cycleNumber)) {
    throw new Error("COMMUNITY_FEED_RESUME_KEY_INVALID");
  }
  return `${STORAGE_PREFIX}.${feed}.cycle-${cycleNumber ?? "all"}`;
}

export function createCommunityFeedResumeRecord({
  feed,
  submissionId,
  context,
  viewedAt = new Date().toISOString(),
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  context: CommunityFeedContext;
  viewedAt?: string;
}): CommunityFeedResumeRecord {
  if (!isPositiveInteger(submissionId) || !isCanonicalTimestamp(viewedAt)) {
    throw new Error("COMMUNITY_FEED_RESUME_INVALID");
  }

  if (feed === "live" && context.kind === "live") {
    return {
      version: COMMUNITY_FEED_RESUME_VERSION,
      feed,
      submissionId,
      viewedAt,
      context: {
        kind: "live",
        cycleNumber: context.cycleNumber,
        resetCount: context.resetCount,
      },
    };
  }

  if (feed !== "live" && context.kind === "finalized") {
    return {
      version: COMMUNITY_FEED_RESUME_VERSION,
      feed,
      submissionId,
      viewedAt,
      context: {
        kind: "finalized",
        classificationVersion: context.classificationVersion,
        cycleNumber: context.cycleNumber,
      },
    };
  }

  throw new Error("COMMUNITY_FEED_RESUME_CONTEXT_INVALID");
}

export function parseCommunityFeedResumeRecord(
  serialized: string
): CommunityFeedResumeRecord | null {
  let value: unknown;

  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }

  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "context",
      "feed",
      "submissionId",
      "version",
      "viewedAt",
    ]) ||
    value.version !== COMMUNITY_FEED_RESUME_VERSION ||
    !isCommunityFeedKind(value.feed) ||
    !isPositiveInteger(value.submissionId) ||
    !isCanonicalTimestamp(value.viewedAt) ||
    !isRecord(value.context) ||
    typeof value.context.kind !== "string"
  ) {
    return null;
  }

  if (
    value.feed === "live" &&
    value.context.kind === "live" &&
    hasExactKeys(value.context, ["cycleNumber", "kind", "resetCount"]) &&
    isPositiveInteger(value.context.cycleNumber) &&
    isNonNegativeInteger(value.context.resetCount)
  ) {
    return {
      version: COMMUNITY_FEED_RESUME_VERSION,
      feed: value.feed,
      submissionId: value.submissionId,
      viewedAt: value.viewedAt,
      context: {
        kind: "live",
        cycleNumber: value.context.cycleNumber,
        resetCount: value.context.resetCount,
      },
    };
  }

  if (
    value.feed !== "live" &&
    value.context.kind === "finalized" &&
    hasExactKeys(value.context, ["classificationVersion", "cycleNumber", "kind"]) &&
    isPositiveInteger(value.context.classificationVersion) &&
    (value.context.cycleNumber === null ||
      isPositiveInteger(value.context.cycleNumber))
  ) {
    return {
      version: COMMUNITY_FEED_RESUME_VERSION,
      feed: value.feed,
      submissionId: value.submissionId,
      viewedAt: value.viewedAt,
      context: {
        kind: "finalized",
        classificationVersion: value.context.classificationVersion,
        cycleNumber: value.context.cycleNumber,
      },
    };
  }

  return null;
}

export function isCommunityFeedResumeCurrent(
  record: CommunityFeedResumeRecord,
  feed: CommunityFeedKind,
  context: CommunityFeedContext | null
) {
  if (record.feed !== feed || context === null) return false;

  if (feed === "live") {
    return (
      record.context.kind === "live" &&
      context.kind === "live" &&
      record.context.cycleNumber === context.cycleNumber &&
      record.context.resetCount === context.resetCount
    );
  }

  return (
    record.context.kind === "finalized" &&
    context.kind === "finalized" &&
    record.context.classificationVersion === context.classificationVersion &&
    record.context.cycleNumber === context.cycleNumber
  );
}
