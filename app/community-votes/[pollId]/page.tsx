import Link from "next/link";
import { notFound } from "next/navigation";
import CommunityPollCard from "@/app/components/communityVotes/CommunityPollCard";
import { getSessionState } from "@/lib/auth/sessionState";
import { getCommunityPoll } from "@/lib/communityPolls/data.server";
import { UUID_PATTERN } from "@/lib/communityPolls/validation";

export const dynamic = "force-dynamic";

export default async function CommunityPollPage({
  params,
}: {
  params: Promise<{ pollId: string }>;
}) {
  const { pollId } = await params;
  if (!UUID_PATTERN.test(pollId)) notFound();
  const sessionState = await getSessionState();
  const viewerId =
    sessionState.status === "authenticated"
      ? sessionState.session.discord_user_id
      : undefined;
  const detail = await getCommunityPoll(pollId, viewerId);
  if (!detail) notFound();
  const { poll, serverNow } = detail;
  const viewerStatus =
    sessionState.status === "restricted"
      ? "restricted"
      : sessionState.status;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,90,31,0.14),transparent_42%),#080808] px-4 py-10 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <nav className="flex flex-wrap gap-3" aria-label="Community Votes navigation">
          <Link className="min-h-11 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-semibold text-white/75 hover:border-orange-400 hover:text-white" href="/community-votes">
            All Community Votes
          </Link>
          <Link className="min-h-11 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-semibold text-white/75 hover:border-orange-400 hover:text-white" href="/">
            Home
          </Link>
        </nav>
        <CommunityPollCard
          initialPoll={poll}
          initialServerNow={serverNow}
          viewerStatus={viewerStatus}
          loginPath={`/community-votes/${poll.publicId}`}
          showStableLink={false}
        />
      </div>
    </main>
  );
}
