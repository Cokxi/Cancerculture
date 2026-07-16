import { getCurrentVotingCycle } from "@/lib/cycles/currentCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getDiscordMembershipEligibility,
  type DiscordMembershipEligibility,
} from "@/lib/eligibility/discordMembership";

export type VoteEligibility = {
  isBanned: boolean;
  activeCycleId: number | null;
  hasVoted: boolean;
  voteCount: number;
  votesPerUser: number;
  votedSubmissionIds: number[];
  membership: DiscordMembershipEligibility;
};

export async function getVoteEligibility(discordUserId: string) {
  const [userLogResult, activeCycle, membership] = await Promise.all([
    supabaseAdmin
      .from("user_logs")
      .select("is_banned")
      .eq("discord_user_id", discordUserId)
      .maybeSingle(),
    getCurrentVotingCycle({ throwOnError: true }),
    getDiscordMembershipEligibility(discordUserId),
  ]);

  if (userLogResult.error || !userLogResult.data) {
    throw new Error("Vote eligibility dependency unavailable");
  }

  const userLog = userLogResult.data;

  let votedSubmissionIds: number[] = [];

  if (activeCycle?.id) {
    const { data: voteRows, error: votesError } = await supabaseAdmin
      .from("votes")
      .select("submission_id")
      .eq("cycle_id", activeCycle.id)
      .eq("discord_user_id", discordUserId);

    if (votesError) {
      throw new Error("Vote eligibility dependency unavailable");
    }

    votedSubmissionIds = (voteRows ?? [])
      .map((vote) => vote.submission_id)
      .filter((submissionId): submissionId is number =>
        Number.isInteger(submissionId)
      );
  }
  const voteCount = votedSubmissionIds.length;
  const votesPerUser = Math.max(
    1,
    Math.min(activeCycle?.votes_per_user ?? 2, 10)
  );

  return {
    isBanned: userLog?.is_banned === true,
    activeCycleId: activeCycle?.id ?? null,
    hasVoted: voteCount >= votesPerUser,
    voteCount,
    votesPerUser,
    votedSubmissionIds,
    membership,
  } satisfies VoteEligibility;
}
