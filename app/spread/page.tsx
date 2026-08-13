import BackButton from "@/app/components/ui/BackButton";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";
import {
  COMMUNITY_FEED_LABELS,
  isCommunityFeedKind,
} from "@/lib/feed/communityFeedSurface";
import { getCommunityFeedSurfacePage } from "@/lib/feed/communityFeedSurface.server";
import CommunityFeedClient from "./CommunityFeedClient";

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
  }>;
}) {
  const resolvedParams = await searchParams;
  const requestedFeed = firstParam(resolvedParams.feed);
  const feed: CommunityFeedKind = isCommunityFeedKind(requestedFeed)
    ? requestedFeed
    : "live";
  const anchorSubmissionId = parseSubmissionId(
    firstParam(resolvedParams.submission)
  );
  const initialPage = await getCommunityFeedSurfacePage({
    feed,
    anchorSubmissionId,
  });

  return (
    <div className="relative min-h-screen bg-orange-background text-white">
      <BackButton href="/" label="Home" />

      <main className="relative z-10 mx-auto w-full max-w-3xl px-4 pb-24 sm:px-6">
        <CommunityFeedClient
          key={feed}
          feed={feed}
          feedLabel={COMMUNITY_FEED_LABELS[feed]}
          initialAnchorRequested={anchorSubmissionId !== null}
          initialPage={initialPage}
        />
      </main>
    </div>
  );
}
