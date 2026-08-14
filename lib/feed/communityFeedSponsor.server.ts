import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import { resolveCommunityFeedCycleSource } from "@/lib/feed/communityFeedReadModel.server";

export type CommunityFeedSponsorSource = {
  sponsorshipId: number;
  cycleId: number;
  companyName: string;
  targetUrl: string;
  bannerR2Key: string;
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
}: {
  feed: CommunityFeedKind;
  submissionId: number;
}): Promise<CommunityFeedSponsorSource | null> {
  const cycle = await resolveCommunityFeedCycleSource({ feed, submissionId });
  if (!cycle) return null;

  let query = supabaseAdmin
    .from("cycle_sponsorships")
    .select("id, cycle_id, sponsor_name, sponsor_link, banner_r2_key, is_active")
    .eq("cycle_id", cycle.cycleId);

  if (feed === "live") query = query.eq("is_active", true);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) return null;

  const companyName =
    typeof data.sponsor_name === "string" ? data.sponsor_name.trim() : "";
  const bannerR2Key =
    typeof data.banner_r2_key === "string" ? data.banner_r2_key.trim() : "";
  const targetUrl = getSafeSponsorTarget(data.sponsor_link);

  if (
    !Number.isSafeInteger(data.id) ||
    data.id <= 0 ||
    data.cycle_id !== cycle.cycleId ||
    companyName.length === 0 ||
    companyName.length > 120 ||
    bannerR2Key.length === 0 ||
    !targetUrl
  ) {
    return null;
  }

  return {
    sponsorshipId: data.id,
    cycleId: cycle.cycleId,
    companyName,
    targetUrl,
    bannerR2Key,
  };
}
