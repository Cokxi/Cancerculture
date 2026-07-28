import type { SponsoredCycleMeta } from "./sponsoredCycle";
import type { SubmissionPublicVisibilityStatus } from "@/lib/moderation/submissionPublicVisibility";
import type { SubmissionSocialLink } from "@/lib/socials/getSubmissionSocialLinks";

export type CycleHistoryWinnerProfile = {
  cycle_id: number;
  submission_id: number;
  wall: string;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
};

export type CycleHistorySubmission = {
  id: number;
  cycleId: number;
  imageUrl: string | null;
  isDisqualified: boolean;
  disqualificationReasonCode: string | null;
  disqualificationReasonText: string | null;
  discordUsername: string;
  publicProfileId: string | null;
  voteCount: number;
  isWinner: boolean;
  rank: number | null;
  publicVisibilityStatus: SubmissionPublicVisibilityStatus;
  publicVisibilityReasonCode: string | null;
  publicVisibilityReasonText: string | null;
  publicVisibilityUpdatedAt: string | null;
  publicVisibilityUpdatedByDiscordUsername: string | null;
  winnerProfile: CycleHistoryWinnerProfile | null;
  socialLinks: SubmissionSocialLink[];
};

export type CycleHistoryCycleSummary = {
  id: number;
  theme: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  submissionCount: number;
};

export type CycleHistoryCycleSummaryItem =
  CycleHistoryCycleSummary & {
    sponsoredMeta: SponsoredCycleMeta | null;
  };

