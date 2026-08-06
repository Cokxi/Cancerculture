import { getSessionState } from "@/lib/auth/sessionState";
import SubmissionsClient from "./SubmissionsClient";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import {
  getCurrentPublicCycle,
  getLatestCycleState,
} from "@/lib/cycles/currentCycle";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";
import {
  getVoteSubmissionById,
  getVoteSubmissions,
} from "@/lib/vote/getVoteSubmissions";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";

export const dynamic = "force-dynamic";

function getInactiveMessage(status: string | null) {
  if (status === "submission_closed") {
    return {
      title: "Submission phase ended",
      text: "Voting will begin shortly.",
    };
  }

  if (status === "voting_closed" || status === "finalizing") {
    return {
      title: "This cycle is wrapping up",
      text: "Voting has ended. Results will be published after finalization.",
    };
  }

  if (status === "completed" || status === "finished") {
    return {
      title: "This cycle has ended",
      text: "Submissions return when the next cycle starts.",
    };
  }

  return {
    title: "No active cycle right now",
    text: "Submissions return when the next cycle starts.",
  };
}

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ submission?: string }>;
}) {
  let discordUserId: string | null = null;
  let viewerBlockReason:
    | "banned"
    | "membership_pending"
    | "dependency_unavailable"
    | "not_authenticated" = "not_authenticated";
  const sessionState = await getSessionState();

  if (sessionState.status === "authenticated") {
    discordUserId = sessionState.session.discord_user_id;
    viewerBlockReason = "membership_pending";
  } else if (sessionState.status === "restricted") {
    viewerBlockReason = "banned";
  } else if (sessionState.status === "dependency_unavailable") {
    viewerBlockReason = "dependency_unavailable";
  }

  await processDueCycleTransitions();

  const [currentCycle, latestCycle, resolvedSearchParams] =
    await Promise.all([
      getCurrentPublicCycle(),
      getLatestCycleState(),
      searchParams,
    ]);
  if (!currentCycle) {
    const message = getInactiveMessage(latestCycle?.status ?? null);

    return (
      <PageWrapper>
        <div className="flex min-h-screen items-center justify-center px-6 text-center">
          <div>
            <h1 className="font-['Permanent_Marker'] text-2xl tracking-wide text-[var(--orange-main)]">
              {message.title}
            </h1>
            <p className="mt-3 text-white/65">{message.text}</p>
          </div>
        </div>
      </PageWrapper>
    );
  }

  const requestedSubmissionId = Number(
    resolvedSearchParams.submission
  );
  const requestedId = Number.isSafeInteger(requestedSubmissionId)
    ? requestedSubmissionId
    : null;
  const [initialPage, sponsoredMeta] = await Promise.all([
    getVoteSubmissions({ cycleId: currentCycle.id }),
    getCycleSponsoredMeta(currentCycle.id),
  ]);
  const initialActiveSubmission =
    requestedId &&
    !initialPage.items.some(
      (submission) => submission.id === requestedId
    )
      ? await getVoteSubmissionById({
          cycleId: currentCycle.id,
          submissionId: requestedId,
        })
      : null;

  return (
    <PageWrapper>
      <SubmissionsClient
        cycleId={currentCycle.id}
        initialPage={initialPage}
        initialActiveSubmission={initialActiveSubmission}
        hasVoted={false}
        voteCount={0}
        votesPerUser={
          Math.max(1, Math.min(currentCycle.votes_per_user ?? 2, 10))
        }
        votedSubmissionIds={[]}
        votingEnabled={
          currentCycle.status === "voting_open" ||
          currentCycle.status === "active"
        }
        isPaused={currentCycle.status === "paused"}
        discordUserId={discordUserId}
        voteBlockedReason={viewerBlockReason}
        voteCooldownJoinedAt={null}
        showDiscordSyncDelayNotice={false}
        sponsoredMeta={sponsoredMeta}
        initialSubmissionId={
          requestedId
        }
        turnstileSiteKey={getTurnstileClientSiteKey()}
      />
    </PageWrapper>
  );
}
