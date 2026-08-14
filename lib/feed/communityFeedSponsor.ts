import type { CommunityFeedKind } from "@/lib/feed/communityFeed";

export type CommunityFeedSponsorPresentation =
  | { sponsored: false }
  | {
      sponsored: true;
      companyName: string;
      bannerUrl: string;
      clickUrl: string;
      impressionUrl: string;
      measurementToken: string | null;
      measurementTokenExpiresAt: string | null;
    };

export function getCommunityFeedSponsorPaths(
  feed: CommunityFeedKind,
  submissionId: number,
  measurementToken: string | null
) {
  const suffix = `${submissionId}?feed=${feed}`;
  const clickParams = new URLSearchParams({ feed });
  if (measurementToken) clickParams.set("token", measurementToken);

  return {
    bannerUrl: `/api/community-feed/sponsor/banner/${suffix}`,
    clickUrl: `/api/community-feed/sponsor/click/${submissionId}?${clickParams.toString()}`,
    impressionUrl: `/api/community-feed/sponsor/impression/${suffix}`,
  };
}

function isExactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function isCommunityFeedSponsorPresentation(
  value: unknown,
  feed: CommunityFeedKind,
  submissionId: number
): value is CommunityFeedSponsorPresentation {
  if (!isExactRecord(value, ["sponsored"])) {
    if (
      !isExactRecord(value, [
        "bannerUrl",
        "clickUrl",
        "companyName",
        "impressionUrl",
        "measurementToken",
        "measurementTokenExpiresAt",
        "sponsored",
      ])
    ) {
      return false;
    }

    const token = value.measurementToken;
    const tokenExpiresAt = value.measurementTokenExpiresAt;
    if (
      value.sponsored !== true ||
      typeof value.companyName !== "string" ||
      value.companyName.length === 0 ||
      value.companyName.length > 120 ||
      (token !== null && (typeof token !== "string" || token.length > 2048))
      ||
      (tokenExpiresAt !== null &&
        (typeof tokenExpiresAt !== "string" ||
          Number.isNaN(new Date(tokenExpiresAt).getTime()))) ||
      ((token === null) !== (tokenExpiresAt === null))
    ) {
      return false;
    }

    const paths = getCommunityFeedSponsorPaths(
      feed,
      submissionId,
      typeof token === "string" ? token : null
    );
    return (
      value.bannerUrl === paths.bannerUrl &&
      value.clickUrl === paths.clickUrl &&
      value.impressionUrl === paths.impressionUrl
    );
  }

  return value.sponsored === false;
}
