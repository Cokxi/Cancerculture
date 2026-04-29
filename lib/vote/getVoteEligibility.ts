import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getDiscordMembershipEligibility,
  type DiscordMembershipEligibility,
} from "@/lib/eligibility/discordMembership";

export type VoteEligibility = {
  isBanned: boolean;
  activeCycleId: number | null;
  hasVoted: boolean;
  membership: DiscordMembershipEligibility;
};

export async function getVoteEligibility(discordUserId: string) {
  const [userLogResult, activeCycle, membership] = await Promise.all([
    supabaseAdmin
      .from("user_logs")
      .select("is_banned")
      .eq("discord_user_id", discordUserId)
      .maybeSingle(),
    getActiveCycle(),
    getDiscordMembershipEligibility(discordUserId),
  ]);

  const userLog = userLogResult.data;

  let hasVoted = false;

  if (activeCycle?.id) {
    const { data: existingVote } = await supabaseAdmin
      .from("votes")
      .select("id")
      .eq("cycle_id", activeCycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    hasVoted = Boolean(existingVote);
  }

  return {
    isBanned: userLog?.is_banned === true,
    activeCycleId: activeCycle?.id ?? null,
    hasVoted,
    membership,
  } satisfies VoteEligibility;
}
