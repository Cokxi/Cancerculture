import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import { evaluateDiscordSyncHealth } from "@/lib/discord/discordSyncHealth";
import { readDiscordSyncHealth } from "@/lib/discord/readDiscordSyncHealth";
import {
  DISCORD_MEMBERSHIP_COOLDOWN_MINUTES,
  getDiscordMembershipCooldown,
  isDiscordMembershipObservationFresh,
} from "@/lib/eligibility/discordMembershipFreshness";

export { DISCORD_MEMBERSHIP_COOLDOWN_MINUTES };

export type DiscordMembershipEligibilityReason =
  | "discord_banned"
  | "membership_pending"
  | "membership_unavailable"
  | "not_in_discord"
  | "joined_too_recently";

export type DiscordMembershipEligibility = {
  isInDiscord: boolean;
  isEligible: boolean;
  isDiscordBanned: boolean;
  membershipKnown: boolean;
  dependencyUnavailable: boolean;
  membershipObservedAt: string | null;
  joinedAt: string | null;
  joinedTooRecently: boolean;
  retryAfterMs: number;
  reason: DiscordMembershipEligibilityReason | null;
};

type DiscordMemberStateRow = {
  discord_ban_active: boolean | null;
  discord_joined_at: string | null;
  discord_membership_observed_at: string | null;
  is_in_discord: boolean | null;
};

async function hasAuthoritativeCurrentMembershipSnapshot() {
  const healthRow = await readDiscordSyncHealth();
  if (!healthRow) return false;

  const health = evaluateDiscordSyncHealth({
    now: new Date(),
    lastHeartbeatAt: healthRow.last_heartbeat_at,
    lastFullReconciliationSucceededAt:
      healthRow.last_full_reconciliation_succeeded_at,
    lastFailureAt: healthRow.last_failure_at,
  });

  return health.status === "healthy";
}

export async function getDiscordMembershipEligibility(
  discordUserId: string
): Promise<DiscordMembershipEligibility> {
  const { data: memberState, error } = await supabaseAdmin
    .from("discord_member_state")
    .select(
      "discord_ban_active, discord_joined_at, discord_membership_observed_at, is_in_discord"
    )
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
      membershipKnown: true,
      dependencyUnavailable: false,
      membershipObservedAt: memberState.discord_membership_observed_at,
      joinedAt: memberState.discord_joined_at,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "discord_banned",
    };
  }

  if (!memberState) {
    const absenceIsAuthoritative =
      await hasAuthoritativeCurrentMembershipSnapshot();

    return {
      isInDiscord: false,
      isEligible: false,
      isDiscordBanned: false,
      membershipKnown: absenceIsAuthoritative,
      dependencyUnavailable: false,
      membershipObservedAt: null,
      joinedAt: null,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: absenceIsAuthoritative
        ? "not_in_discord"
        : "membership_pending",
    };
  }

  if (
    !isDiscordMembershipObservationFresh(
      memberState.discord_membership_observed_at
    )
  ) {
    return {
      isInDiscord: memberState.is_in_discord === true,
      isEligible: false,
      isDiscordBanned: false,
      membershipKnown: false,
      dependencyUnavailable: false,
      membershipObservedAt:
        memberState.discord_membership_observed_at,
      joinedAt: memberState.discord_joined_at,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "membership_pending",
    };
  }

  if (!memberState.is_in_discord) {
    return {
      isInDiscord: false,
      isEligible: false,
      isDiscordBanned: false,
      membershipKnown: true,
      dependencyUnavailable: false,
      membershipObservedAt: memberState.discord_membership_observed_at,
      joinedAt: memberState.discord_joined_at,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "not_in_discord",
    };
  }

  const joinedAt = memberState.discord_joined_at;
  const cooldown = getDiscordMembershipCooldown(joinedAt);

  if (!cooldown) {
    return {
      isInDiscord: true,
      isEligible: false,
      isDiscordBanned: false,
      membershipKnown: true,
      dependencyUnavailable: true,
      membershipObservedAt: memberState.discord_membership_observed_at,
      joinedAt,
      joinedTooRecently: false,
      retryAfterMs: 0,
      reason: "membership_unavailable",
    };
  }

  const { joinedTooRecently, retryAfterMs } = cooldown;

  return {
    isInDiscord: true,
    isEligible: !joinedTooRecently,
    isDiscordBanned: false,
    membershipKnown: true,
    dependencyUnavailable: false,
    membershipObservedAt: memberState.discord_membership_observed_at,
    joinedAt,
    joinedTooRecently,
    retryAfterMs,
    reason: joinedTooRecently ? "joined_too_recently" : null,
  };
}
