import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { supabaseAdmin } from "@/lib/db/admin";

export type VoteEligibility = {
  isBanned: boolean;
  activeCycleId: number | null;
  hasVoted: boolean;
};

export async function getVoteEligibility(discordUserId: string) {
  const { data: userLog } = await supabaseAdmin
    .from("user_logs")
    .select("is_banned")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  const activeCycle = await getActiveCycle();

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
  } satisfies VoteEligibility;
}
