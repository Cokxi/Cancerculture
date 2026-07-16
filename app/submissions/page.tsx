import { getAuthErrorCode } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
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
import { getVoteEligibility } from "@/lib/vote/getVoteEligibility";

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
    | "not_in_discord"
    | "joined_too_recently"
    | "not_authenticated" = "not_authenticated";

  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch (error) {
    const authCode = getAuthErrorCode(error)?.split(":")[0];
    viewerBlockReason =
      authCode === "DISCORD_BANNED" || authCode === "WEBSITE_BANNED"
        ? "banned"
        : authCode === "NOT_IN_DISCORD"
          ? "not_in_discord"
          : authCode === "JOINED_TOO_RECENTLY"
            ? "joined_too_recently"
            : "not_authenticated";
  }

  await processDueCycleTransitions();

  const [currentCycle, latestCycle, resolvedSearchParams] =
    await Promise.all([
      getCurrentPublicCycle(),
      getLatestCycleState(),
      searchParams,
    ]);
  const voteEligibility = discordUserId
    ? await getVoteEligibility(discordUserId)
    : null;

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
  const voteBlockedReason = !voteEligibility
    ? viewerBlockReason
    : voteEligibility.isBanned
    ? "banned"
    : !voteEligibility.membership.isInDiscord
      ? "not_in_discord"
      : voteEligibility.membership.joinedTooRecently
        ? "joined_too_recently"
        : null;

  return (
    <PageWrapper>
      <SubmissionsClient
        submissions={submissionsWithUrls}
        hasVoted={voteEligibility?.hasVoted ?? false}
        voteCount={voteEligibility?.voteCount ?? 0}
        votesPerUser={
          voteEligibility?.votesPerUser ??
          Math.max(1, Math.min(currentCycle.votes_per_user ?? 2, 10))
        }
        votedSubmissionIds={voteEligibility?.votedSubmissionIds ?? []}
        votingEnabled={
          currentCycle.status === "voting_open" ||
          currentCycle.status === "active"
        }
        isPaused={currentCycle.status === "paused"}
        discordUserId={discordUserId}
        voteBlockedReason={voteBlockedReason}
        voteCooldownJoinedAt={
          voteEligibility?.membership.joinedAt ?? null
        }
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
