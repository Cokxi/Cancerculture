import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";
import type { SubmissionPublicVisibilityStatus } from "@/lib/moderation/submissionPublicVisibility";
import type { SubmissionSocialLink } from "@/lib/socials/getSubmissionSocialLinks";

export type PublicWallItem = {
  id: number;
  submission_id: number;
  image_url: string | null;
  cycle_id: number;
  created_at: string | null;
  discord_username: string;
  public_profile_id: string | null;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
  vote_count: number | null;
  public_visibility_status: SubmissionPublicVisibilityStatus;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
  social_links: SubmissionSocialLink[];
  sponsored_meta: SponsoredCycleMeta | null;
};

