import type { DiscordSyncHealthStatus } from "@/lib/discord/discordSyncHealth";
import type { DiscordMembershipEligibilityReason } from "@/lib/eligibility/discordMembership";
import {
  DISCORD_MEMBERSHIP_FRESHNESS_MS,
  getDiscordMembershipCooldown,
} from "@/lib/eligibility/discordMembershipFreshness";

export type DiscordSyncParticipationGraceMode =
  | "preserve_existing_decision"
  | "degraded_grace"
  | "pending"
  | "blocked";

export type DiscordSyncParticipationGraceReason =
  | DiscordMembershipEligibilityReason
  | "existing_decision_allowed"
  | "existing_decision_blocked"
  | "confirmed_member_sync_stale"
  | "pending_new_or_rejoining_member"
  | "membership_observation_missing"
  | "membership_observation_invalid"
  | "membership_observation_future"
  | "membership_observation_not_stale"
  | "join_timestamp_invalid"
  | "website_banned"
  | "session_revoked"
  | "session_invalid"
  | "dependency_unavailable"
  | "now_invalid";

export type DiscordSyncParticipationGraceInput = {
  now: Date | string;
  syncHealthStatus: DiscordSyncHealthStatus;
  existingDecision: {
    allowed: boolean;
    reason: DiscordMembershipEligibilityReason | null;
  };
  isInDiscord: boolean;
  membershipObservedAt: Date | string | null;
  joinedAt: Date | string | null;
  websiteBanned: boolean;
  discordBanned: boolean;
  sessionStatus: "valid" | "revoked" | "invalid";
  dependencyUnavailable: boolean;
};

export type DiscordSyncParticipationGraceDecision = {
  allowed: boolean;
  mode: DiscordSyncParticipationGraceMode;
  reason: DiscordSyncParticipationGraceReason;
  usedDegradedGrace: boolean;
};

function preserveExistingDecision(
  existingDecision: DiscordSyncParticipationGraceInput["existingDecision"]
): DiscordSyncParticipationGraceDecision {
  return {
    allowed: existingDecision.allowed,
    mode: "preserve_existing_decision",
    reason:
      existingDecision.reason ??
      (existingDecision.allowed
        ? "existing_decision_allowed"
        : "existing_decision_blocked"),
    usedDegradedGrace: false,
  };
}

function blocked(
  reason: DiscordSyncParticipationGraceReason
): DiscordSyncParticipationGraceDecision {
  return {
    allowed: false,
    mode: "blocked",
    reason,
    usedDegradedGrace: false,
  };
}

function pending(
  reason: DiscordSyncParticipationGraceReason
): DiscordSyncParticipationGraceDecision {
  return {
    allowed: false,
    mode: "pending",
    reason,
    usedDegradedGrace: false,
  };
}

function timestampMs(value: Date | string) {
  const parsed =
    value instanceof Date ? value.getTime() : Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

export function decideDiscordSyncParticipationGrace(
  input: DiscordSyncParticipationGraceInput
): DiscordSyncParticipationGraceDecision {
  if (input.sessionStatus === "revoked") {
    return blocked("session_revoked");
  }

  if (input.sessionStatus !== "valid") {
    return blocked("session_invalid");
  }

  if (input.dependencyUnavailable) {
    return blocked("dependency_unavailable");
  }

  if (input.websiteBanned) {
    return blocked("website_banned");
  }

  if (input.discordBanned) {
    return blocked("discord_banned");
  }

  if (input.syncHealthStatus === "healthy") {
    return preserveExistingDecision(input.existingDecision);
  }

  if (input.existingDecision.allowed) {
    return preserveExistingDecision(input.existingDecision);
  }

  if (!input.isInDiscord) {
    return input.existingDecision.reason === "membership_pending"
      ? pending("pending_new_or_rejoining_member")
      : blocked("not_in_discord");
  }

  if (input.existingDecision.reason !== "membership_pending") {
    return preserveExistingDecision(input.existingDecision);
  }

  const nowMs = timestampMs(input.now);
  if (nowMs === null) {
    return blocked("now_invalid");
  }

  if (input.membershipObservedAt === null) {
    return pending("membership_observation_missing");
  }

  const observedAtMs = timestampMs(input.membershipObservedAt);
  if (observedAtMs === null) {
    return pending("membership_observation_invalid");
  }

  if (observedAtMs > nowMs) {
    return pending("membership_observation_future");
  }

  if (nowMs - observedAtMs <= DISCORD_MEMBERSHIP_FRESHNESS_MS) {
    return pending("membership_observation_not_stale");
  }

  if (input.joinedAt === null) {
    return blocked("join_timestamp_invalid");
  }

  const joinedAtMs = timestampMs(input.joinedAt);
  if (joinedAtMs === null || joinedAtMs > nowMs) {
    return blocked("join_timestamp_invalid");
  }

  const cooldown = getDiscordMembershipCooldown(
    new Date(joinedAtMs).toISOString(),
    nowMs
  );

  if (!cooldown) {
    return blocked("join_timestamp_invalid");
  }

  if (cooldown.joinedTooRecently) {
    return blocked("joined_too_recently");
  }

  return {
    allowed: true,
    mode: "degraded_grace",
    reason: "confirmed_member_sync_stale",
    usedDegradedGrace: true,
  };
}
