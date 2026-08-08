import { getCurrentVotingCycle } from "@/lib/cycles/currentCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getDiscordMembershipEligibility,
  type DiscordMembershipEligibility,
} from "@/lib/eligibility/discordMembership";
import { getViewerVoteState } from "@/lib/vote/viewerVoteState.server";

export type VoteEligibility = {
  isBanned: boolean;
  activeCycleId: number | null;
  hasVoted: boolean;
  voteCount: number;
  votesPerUser: number;
  votedSubmissionIds: readonly number[];
  membership: DiscordMembershipEligibility;
};

export async function getVoteEligibility(
  discordUserId: string,
  membershipOverride?: DiscordMembershipEligibility
) {
  const [userLogResult, activeCycle, membership] = await Promise.all([
    supabaseAdmin
      .from("user_logs")
      .select("is_banned")
      .eq("discord_user_id", discordUserId)
      .maybeSingle(),
    getCurrentVotingCycle({ throwOnError: true }),
    membershipOverride ?? getDiscordMembershipEligibility(discordUserId),
  ]);

  if (userLogResult.error || !userLogResult.data) {
    throw new Error("Vote eligibility dependency unavailable");
  }

  const userLog = userLogResult.data;

  const viewerVoteState = activeCycle?.id
    ? await getViewerVoteState({
        cycleId: activeCycle.id,
        discordUserId,
      })
    : { voteCount: 0, votedSubmissionIds: [] };
  const votedSubmissionIds = viewerVoteState.votedSubmissionIds;
  const voteCount = viewerVoteState.voteCount;
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
