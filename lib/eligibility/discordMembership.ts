import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";

export const DISCORD_MEMBERSHIP_COOLDOWN_MINUTES = 10;

const DISCORD_MEMBERSHIP_COOLDOWN_MS =
  DISCORD_MEMBERSHIP_COOLDOWN_MINUTES * 60 * 1000;

export type DiscordMembershipEligibilityReason =
  | "discord_banned"
  | "not_in_discord"
  | "joined_too_recently";

export type DiscordMembershipEligibility = {
  isInDiscord: boolean;
  isEligible: boolean;
  isDiscordBanned: boolean;
  joinedAt: string | null;
  joinedTooRecently: boolean;
  retryAfterMs: number;
  reason: DiscordMembershipEligibilityReason | null;
};

type DiscordMemberStateRow = {
  discord_ban_active: boolean | null;
  discord_joined_at: string | null;
  is_in_discord: boolean | null;
};

export async function getDiscordMembershipEligibility(
  discordUserId: string
): Promise<DiscordMembershipEligibility> {
  const { data: memberState, error } = await supabaseAdmin
    .from("discord_member_state")
    .select("discord_ban_active, discord_joined_at, is_in_discord")
    .eq("discord_user_id", discordUserId)
    .maybeSingle<DiscordMemberStateRow>();

  if (error) {
    console.error("[discord membership eligibility]", {
      code: error.code,
    });
    throw new AuthError(
      503,
      "Discord membership service temporarily unavailable",
      "MEMBERSHIP_UNAVAILABLE"
    );
  }

  if (memberState?.discord_ban_active) {
    return {
      isInDiscord: false,
      isEligible: false,
      isDiscordBanned: true,
      joinedAt: memberState.discord_joined_at,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "discord_banned",
    };
  }

  if (!memberState?.is_in_discord) {
    return {
      isInDiscord: false,
      isEligible: false,
      isDiscordBanned: false,
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
      isDiscordBanned: false,
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
    isDiscordBanned: false,
    joinedAt,
    joinedTooRecently,
    retryAfterMs,
    reason: joinedTooRecently ? "joined_too_recently" : null,
  };
}
