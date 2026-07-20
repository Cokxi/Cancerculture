import { getSessionState } from "@/lib/auth/sessionState";
import SubmissionsClient from "./SubmissionsClient";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import {
  getCurrentPublicCycle,
  getLatestCycleState,
} from "@/lib/cycles/currentCycle";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";
import { supabaseServer } from "@/lib/db/server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

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

  const { data: submissions } = await supabaseServer
    .from("public_submissions_with_votes")
    .select("id, r2_key, vote_count, discord_user_id")
    .eq("cycle_id", currentCycle.id)
    .order("id", { ascending: true });

  const submissionsWithUrls =
    submissions?.map((s) => ({
      ...s,
      image_url: getPublicImageUrl(s.r2_key) ?? "",
    })) ?? [];
  const sponsoredMeta = await getCycleSponsoredMeta(
    currentCycle.id
  );
  const requestedSubmissionId = Number(
    resolvedSearchParams.submission
  );
  return (
    <PageWrapper>
      <SubmissionsClient
        submissions={submissionsWithUrls}
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
          Number.isInteger(requestedSubmissionId)
            ? requestedSubmissionId
            : null
        }
      />
    </PageWrapper>
  );
}
