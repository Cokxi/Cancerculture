import BackButton from "@/app/components/ui/BackButton";
import { redirect } from "next/navigation";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import {
  COMMUNITY_FEED_LABELS,
  getCommunityFeedHref,
  isCommunityFeedKind,
  parseCommunityFeedCycleNumber,
} from "@/lib/feed/communityFeedSurface";
import { getCommunityFeedSurfacePage } from "@/lib/feed/communityFeedSurface.server";
import CommunityFeedClient from "./CommunityFeedClient";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseSubmissionId(value: string | undefined) {
  if (!value) return null;
  const submissionId = Number(value);
  return Number.isSafeInteger(submissionId) && submissionId > 0
    ? submissionId
    : null;
}

export default async function CommunityFeedPage({
  searchParams,
}: {
  searchParams: Promise<{
    feed?: string | string[];
    submission?: string | string[];
    cycle?: string | string[];
  }>;
}) {
  const resolvedParams = await searchParams;
  const requestedFeed = firstParam(resolvedParams.feed);
  const feed: CommunityFeedKind = isCommunityFeedKind(requestedFeed)
    ? requestedFeed
    : "live";
  const rawCycle = firstParam(resolvedParams.cycle);
  const parsedCycle =
    rawCycle === undefined ? null : parseCommunityFeedCycleNumber(rawCycle);
  if (
    rawCycle !== undefined &&
    (feed === "live" || parsedCycle === null)
  ) {
    redirect(getCommunityFeedHref(feed));
  }
  const cycleNumber = parsedCycle;
  const anchorSubmissionId = parseSubmissionId(
    firstParam(resolvedParams.submission)
  );
  const initialPage = await getCommunityFeedSurfacePage({
    feed,
    anchorSubmissionId,
    cycleNumber,
  });

  return (
    <div className="relative min-h-screen bg-orange-background text-white">
      <BackButton href="/" label="Home" nativeNavigation />

      <main className="relative z-10 w-full px-4 pb-24 sm:px-6">
        <CommunityFeedClient
          key={`${feed}:${cycleNumber ?? "all"}`}
          feed={feed}
          cycleNumber={cycleNumber}
          feedLabel={COMMUNITY_FEED_LABELS[feed]}
          initialAnchorRequested={anchorSubmissionId !== null}
          initialPage={initialPage}
          turnstileSiteKey={getTurnstileClientSiteKey()}
        />
      </main>
    </div>
  );
}
