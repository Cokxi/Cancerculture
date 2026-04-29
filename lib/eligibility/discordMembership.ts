import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export const DISCORD_MEMBERSHIP_COOLDOWN_MINUTES = 10;

const DISCORD_MEMBERSHIP_COOLDOWN_MS =
  DISCORD_MEMBERSHIP_COOLDOWN_MINUTES * 60 * 1000;

export type DiscordMembershipEligibilityReason =
  | "not_in_discord"
  | "joined_too_recently";

export type DiscordMembershipEligibility = {
  isInDiscord: boolean;
  isEligible: boolean;
  joinedAt: string | null;
  joinedTooRecently: boolean;
  retryAfterMs: number;
  reason: DiscordMembershipEligibilityReason | null;
};

type DiscordMemberStateRow = {
  discord_joined_at: string | null;
  is_in_discord: boolean | null;
};

export async function getDiscordMembershipEligibility(
  discordUserId: string
): Promise<DiscordMembershipEligibility> {
  const { data: memberState } = await supabaseAdmin
    .from("discord_member_state")
    .select("discord_joined_at, is_in_discord")
    .eq("discord_user_id", discordUserId)
    .maybeSingle<DiscordMemberStateRow>();

  if (!memberState?.is_in_discord) {
    return {
      isInDiscord: false,
      isEligible: false,
      joinedAt: memberState?.discord_joined_at ?? null,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "not_in_discord",
    };
  }

  const joinedAt = memberState.discord_joined_at;
  const joinedAtMs = joinedAt ? new Date(joinedAt).getTime() : NaN;

  if (!Number.isFinite(joinedAtMs)) {
    return {
      isInDiscord: true,
      isEligible: false,
      joinedAt,
      joinedTooRecently: true,
      retryAfterMs: DISCORD_MEMBERSHIP_COOLDOWN_MS,
      reason: "joined_too_recently",
    };
  }

  const membershipAgeMs = Date.now() - joinedAtMs;
  const retryAfterMs = Math.max(
    0,
    DISCORD_MEMBERSHIP_COOLDOWN_MS - membershipAgeMs
  );
  const joinedTooRecently = retryAfterMs > 0;

  return {
    isInDiscord: true,
    isEligible: !joinedTooRecently,
    joinedAt,
    joinedTooRecently,
    retryAfterMs,
    reason: joinedTooRecently ? "joined_too_recently" : null,
  };
}
