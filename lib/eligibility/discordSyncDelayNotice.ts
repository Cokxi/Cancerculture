import type { DiscordSyncHealthStatus } from "@/lib/discord/discordSyncHealth";
import type { DiscordMembershipEligibilityReason } from "@/lib/eligibility/discordMembership";

export const DISCORD_SYNC_DELAY_NOTICE_TITLE =
  "Discord verification is currently delayed.";
export const DISCORD_SYNC_DELAY_NOTICE_BODY =
  "New and returning members may take longer than usual to be verified. The team has already been notified and is working to restore synchronization.";
export const DISCORD_SYNC_DELAY_NOTICE_GUIDANCE =
  "Please remain on the Discord server. Leaving and rejoining will not speed up verification. Your status will update automatically once synchronization is restored.";

export type DiscordSyncDelayNoticeContext = {
  authenticated: boolean;
  participationEligible: boolean;
  membershipReason: DiscordMembershipEligibilityReason | null;
  websiteBanned: boolean;
  discordBanned: boolean;
  sessionValid: boolean;
  dependencyUnavailable: boolean;
  usedDegradedGrace: boolean;
};

export type DiscordSyncDelayNoticeInput = DiscordSyncDelayNoticeContext & {
  syncHealthStatus: DiscordSyncHealthStatus;
};

export type DiscordSyncDelayNoticeDecision = {
  showDiscordSyncDelayNotice: boolean;
};

export function isDiscordSyncDelayNoticeCandidate(
  input: DiscordSyncDelayNoticeContext
) {
  return (
    input.authenticated &&
    input.sessionValid &&
    !input.participationEligible &&
    !input.usedDegradedGrace &&
    !input.websiteBanned &&
    !input.discordBanned &&
    !input.dependencyUnavailable &&
    (input.membershipReason === "not_in_discord" ||
      input.membershipReason === "membership_pending")
  );
}

export function decideDiscordSyncDelayNotice(
  input: DiscordSyncDelayNoticeInput
): DiscordSyncDelayNoticeDecision {
  return {
    showDiscordSyncDelayNotice:
      isDiscordSyncDelayNoticeCandidate(input) &&
      input.syncHealthStatus !== "healthy",
  };
}
