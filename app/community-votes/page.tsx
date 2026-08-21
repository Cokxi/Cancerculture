import Link from "next/link";
import CommunityPollCard from "@/app/components/communityVotes/CommunityPollCard";
import { getSessionState } from "@/lib/auth/sessionState";
import { getCommunityPollIndex } from "@/lib/communityPolls/data.server";
import type { CommunityPollIndex } from "@/lib/communityPolls/types";

export const dynamic = "force-dynamic";

export default async function CommunityVotesPage() {
  const sessionState = await getSessionState().catch(() => ({
    status: "dependency_unavailable" as const,
  }));
  const viewerId =
    sessionState.status === "authenticated"
      ? sessionState.session.discord_user_id
      : undefined;
  let dependencyUnavailable = sessionState.status === "dependency_unavailable";
  let index: CommunityPollIndex;
  try {
    index = await getCommunityPollIndex(viewerId);
  } catch {
    dependencyUnavailable = true;
    index = Object.freeze({
      serverNow: new Date().toISOString(),
      activePolls: Object.freeze([]),
      historyPolls: Object.freeze([]),
    });
  }
  const viewerStatus =
    sessionState.status === "restricted"
      ? "restricted"
      : sessionState.status;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(255,90,31,0.14),transparent_42%),#080808] px-4 py-10 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-12">
        <header className="space-y-4 text-center">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/75 hover:border-orange-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
          >
            Home
          </Link>
          <p className="text-xs uppercase tracking-[0.28em] text-orange-300/80">
            Community decisions
          </p>
          <h1 className="font-permanent-marker text-4xl text-[var(--orange-main)] sm:text-6xl">
            Community Votes
          </h1>
          <p className="mx-auto max-w-3xl text-sm leading-6 text-white/65 sm:text-base">
            Read every poll publicly. A valid CancerCulture website session can cast one irrevocable vote per poll; Discord server membership and Participation Hold do not decide eligibility.
          </p>
        </header>

        {dependencyUnavailable ? (
          <p role="alert" className="rounded-xl border border-white/15 bg-white/[0.04] p-4 text-center text-sm text-white/70">
            Community Votes are temporarily unavailable. No eligibility or result state has been assumed; please try again later.
          </p>
        ) : null}

        <section aria-labelledby="active-polls" className="space-y-5">
          <div>
            <h2 id="active-polls" className="font-permanent-marker text-3xl text-white">
              Active polls
            </h2>
            <p className="mt-2 text-sm text-white/55">
              Live results stay hidden until your own vote is committed.
            </p>
          </div>
          {index.activePolls.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/20 p-7 text-center text-white/55">
              {dependencyUnavailable
                ? "Active polls could not be loaded."
                : "No Community polls are active right now."}
            </p>
          ) : (
            <div className="grid gap-6">
              {index.activePolls.map((poll) => (
                <CommunityPollCard
                  key={poll.publicId}
                  initialPoll={poll}
                  initialServerNow={index.serverNow}
                  viewerStatus={viewerStatus}
                  loginPath="/community-votes"
                />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="poll-history" className="space-y-5">
          <div>
            <h2 id="poll-history" className="font-permanent-marker text-3xl text-white">
              Poll history
            </h2>
            <p className="mt-2 text-sm text-white/55">
              Completed history contains aggregate counts and percentages only.
            </p>
          </div>
          {index.historyPolls.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/20 p-7 text-center text-white/55">
              {dependencyUnavailable
                ? "Poll history could not be loaded."
                : "No historical Community polls yet."}
            </p>
          ) : (
            <div className="grid gap-6">
              {index.historyPolls.map((poll) => (
                <CommunityPollCard
                  key={poll.publicId}
                  initialPoll={poll}
                  initialServerNow={index.serverNow}
                  viewerStatus={viewerStatus}
                  loginPath="/community-votes"
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
