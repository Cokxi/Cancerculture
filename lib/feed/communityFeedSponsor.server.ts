import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import { isSponsorFeedBannerKey } from "@/lib/sponsors/bannerMedia.server";

export type CommunityFeedSponsorSource = {
  sponsorshipId: number;
  cycleId: number;
  companyName: string;
  targetUrl: string;
  feedBannerR2Key: string;
  placementOrdinal: number;
};

function getSafeSponsorTarget(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function resolveCommunityFeedSponsorSource({
  feed,
  submissionId,
  cycleNumber = null,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  cycleNumber?: number | null;
}): Promise<CommunityFeedSponsorSource | null> {
  if (
    !Number.isSafeInteger(submissionId) ||
    submissionId <= 0 ||
    (cycleNumber !== null &&
      (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0)) ||
    (feed === "live" && cycleNumber !== null)
  ) {
    return null;
  }

  const { data, error } = await supabaseAdmin.rpc(
    "resolve_community_feed_sponsor_placement",
    {
      p_feed_kind: feed,
      p_submission_id: submissionId,
      p_cycle_number: cycleNumber,
    }
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row || typeof row !== "object") return null;

  const source = row as Record<string, unknown>;
  const sponsorshipId = Number(source.sponsorship_id);
  const cycleId = Number(source.cycle_id);
  const placementOrdinal = Number(source.placement_ordinal);
  const companyName =
    typeof source.sponsor_name === "string" ? source.sponsor_name.trim() : "";
  const targetUrl = getSafeSponsorTarget(source.sponsor_link);
  const feedBannerR2Key =
    typeof source.feed_banner_r2_key === "string"
      ? source.feed_banner_r2_key.trim()
      : "";

  if (
    !Number.isSafeInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !Number.isSafeInteger(cycleId) ||
    cycleId <= 0 ||
    !Number.isSafeInteger(placementOrdinal) ||
    placementOrdinal <= 0 ||
    companyName.length === 0 ||
    companyName.length > 120 ||
    !targetUrl ||
    !isSponsorFeedBannerKey(feedBannerR2Key)
  ) {
    return null;
  }

  return {
    sponsorshipId,
    cycleId,
    companyName,
    targetUrl,
    feedBannerR2Key,
    placementOrdinal,
  };
}
