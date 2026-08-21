export const COMMUNITY_FEED_DETAIL_KEYS = [
  "submissionId",
  "state",
  "cycleNumber",
  "author",
  "imageUrl",
  "mediaWidth",
  "mediaHeight",
  "createdAt",
  "cycleStartedAt",
  "cycleEndedAt",
  "finalizedAt",
  "finalVoteCount",
  "rankInCycle",
  "payout",
] as const;

import { parsePublicPayoutDetails, type PublicPayoutDetails } from "@/lib/payouts/public";

export const COMMUNITY_FEED_DETAIL_AUTHOR_KEYS = [
  "publicProfileId",
  "displayName",
  "avatarUrl",
] as const;

export type CommunityFeedDetailAuthor = {
  publicProfileId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type CommunityFeedDetail = {
  submissionId: number;
  state: "live" | "finalized";
  cycleNumber: number;
  author: CommunityFeedDetailAuthor | null;
  imageUrl: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  createdAt: string;
  cycleStartedAt: string | null;
  cycleEndedAt: string | null;
  finalizedAt: string | null;
  finalVoteCount: number | null;
  rankInCycle: number | null;
  payout: PublicPayoutDetails | null;
};

function requireSubmissionId(submissionId: number) {
  if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
    throw new TypeError("Invalid community Feed detail submission id");
  }

  return submissionId;
}

export function getCommunityFeedDetailHref(submissionId: number) {
  return `/spread/${requireSubmissionId(submissionId)}`;
}

export function getCommunityFeedDetailMediaPath(submissionId: number) {
  return `/api/community-feed/detail/media/${requireSubmissionId(submissionId)}`;
}

function isNullableCanonicalTimestamp(value: unknown) {
  return (
    value === null ||
    (typeof value === "string" &&
      !Number.isNaN(new Date(value).getTime()) &&
      new Date(value).toISOString() === value)
  );
}

function hasExactKeys(value: Record<string, unknown>) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...COMMUNITY_FEED_DETAIL_KEYS].sort())
  );
}

function hasExactAuthorKeys(value: Record<string, unknown>) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...COMMUNITY_FEED_DETAIL_AUTHOR_KEYS].sort())
  );
}

function isCommunityFeedDetailAuthor(
  value: unknown
): value is CommunityFeedDetailAuthor {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactAuthorKeys(value as Record<string, unknown>)
  ) {
    return false;
  }

  const author = value as Record<string, unknown>;
  const publicProfileId = author.publicProfileId;
  const avatarPrefix =
    typeof publicProfileId === "string"
      ? `/profile/${encodeURIComponent(publicProfileId)}/avatar?v=`
      : null;

  return (
    typeof publicProfileId === "string" &&
    publicProfileId.trim() === publicProfileId &&
    publicProfileId.length > 0 &&
    typeof author.displayName === "string" &&
    author.displayName.trim() === author.displayName &&
    author.displayName.length > 0 &&
    (author.avatarUrl === null ||
      (typeof author.avatarUrl === "string" &&
        avatarPrefix !== null &&
        author.avatarUrl.startsWith(avatarPrefix) &&
        /^[a-f0-9]{16}$/u.test(author.avatarUrl.slice(avatarPrefix.length))))
  );
}

export function isCommunityFeedDetail(
  value: unknown
): value is CommunityFeedDetail {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>)
  ) {
    return false;
  }

  const detail = value as Record<string, unknown>;
  const dimensionsAreValid =
    (detail.mediaWidth === null && detail.mediaHeight === null) ||
    (Number.isSafeInteger(detail.mediaWidth) &&
      Number(detail.mediaWidth) > 0 &&
      Number.isSafeInteger(detail.mediaHeight) &&
      Number(detail.mediaHeight) > 0);
  const resultIsValid =
    detail.state === "live"
      ? detail.finalizedAt === null &&
        detail.finalVoteCount === null &&
        detail.rankInCycle === null &&
        detail.author === null
      : detail.state === "finalized" &&
        typeof detail.finalVoteCount === "number" &&
        Number.isSafeInteger(detail.finalVoteCount) &&
        detail.finalVoteCount > 0 &&
        typeof detail.rankInCycle === "number" &&
        Number.isSafeInteger(detail.rankInCycle) &&
        detail.rankInCycle > 0 &&
        typeof detail.finalizedAt === "string" &&
        isNullableCanonicalTimestamp(detail.finalizedAt) &&
        (detail.author === null ||
          isCommunityFeedDetailAuthor(detail.author));
  const payoutIsValid = detail.payout === null || parsePublicPayoutDetails(detail.payout) !== null;

  return (
    Number.isSafeInteger(detail.submissionId) &&
    Number(detail.submissionId) > 0 &&
    Number.isSafeInteger(detail.cycleNumber) &&
    Number(detail.cycleNumber) > 0 &&
    (detail.imageUrl === null ||
      detail.imageUrl ===
        getCommunityFeedDetailMediaPath(Number(detail.submissionId))) &&
    dimensionsAreValid &&
    typeof detail.createdAt === "string" &&
    isNullableCanonicalTimestamp(detail.createdAt) &&
    isNullableCanonicalTimestamp(detail.cycleStartedAt) &&
    isNullableCanonicalTimestamp(detail.cycleEndedAt) &&
    payoutIsValid &&
    resultIsValid
  );
}
