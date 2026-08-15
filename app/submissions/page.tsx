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
import {
  getViewerVoteState,
  type ViewerVoteState,
} from "@/lib/vote/viewerVoteState.server";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";
import { requirePublicCycleNumber } from "@/lib/cycles/publicCycleNumber";

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
  const votingEnabled =
    currentCycle.status === "voting_open" ||
    currentCycle.status === "active";
  const viewerVoteStatePromise: Promise<ViewerVoteState | null> =
    discordUserId && votingEnabled
      ? getViewerVoteState({
          cycleId: currentCycle.id,
          discordUserId,
        }).catch((error) => {
          console.error("[SUBMISSIONS] initial viewer vote state unavailable", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          return null;
        })
      : Promise.resolve({ voteCount: 0, votedSubmissionIds: [] });
  const [initialPage, sponsoredMeta, viewerVoteState] = await Promise.all([
    getVoteSubmissions({
      cycleId: currentCycle.id,
      viewerDiscordUserId: discordUserId,
    }),
    getCycleSponsoredMeta(currentCycle.id, "vote_modal"),
    viewerVoteStatePromise,
  ]);
  const initialActiveSubmission =
    requestedId &&
    !initialPage.items.some(
      (submission) => submission.id === requestedId
    )
      ? await getVoteSubmissionById({
          cycleId: currentCycle.id,
          submissionId: requestedId,
          viewerDiscordUserId: discordUserId,
        })
      : null;

  return (
    <PageWrapper>
      <SubmissionsClient
        cycleId={currentCycle.id}
        cycleNumber={requirePublicCycleNumber(currentCycle.public_number)}
        initialPage={initialPage}
        initialActiveSubmission={initialActiveSubmission}
        hasVoted={
          (viewerVoteState?.voteCount ?? 0) >=
          Math.max(1, Math.min(currentCycle.votes_per_user ?? 2, 50))
        }
        voteCount={viewerVoteState?.voteCount ?? 0}
        votesPerUser={
          Math.max(1, Math.min(currentCycle.votes_per_user ?? 2, 50))
        }
        votedSubmissionIds={viewerVoteState?.votedSubmissionIds ?? []}
        initialVoteStateAvailable={viewerVoteState !== null}
        votingEnabled={votingEnabled}
        isVotingClosed={currentCycle.status === "voting_closed"}
        isPaused={currentCycle.status === "paused"}
        isAuthenticated={discordUserId !== null}
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
