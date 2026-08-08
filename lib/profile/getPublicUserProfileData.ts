import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/db/server";
import {
  isSubmissionListedPublicly,
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
} from "@/lib/moderation/submissionPublicVisibility";
import { getUserSubmissions } from "@/lib/queries/getUserSubmissions";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getUserSocialLinks } from "@/lib/socials/getUserSocialLinks";
import type { PublicSocialLink } from "@/lib/socials/types";
import type { SubmissionPublicVisibilityStatus } from "@/lib/moderation/submissionPublicVisibility";

type BasePublicSubmission = Awaited<
  ReturnType<typeof getUserSubmissions>
>[number];

export type PublicProfileSubmission = Omit<
  BasePublicSubmission,
  | "image_url"
  | "is_disqualified"
  | "disqualification_reason_code"
  | "disqualification_reason_text"
  | "disqualified_by_discord_username"
> & {
  image_url: string | null;
  public_visibility_status: SubmissionPublicVisibilityStatus;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
};

export type PublicUserProfileData = {
  avatarUrl: string | null;
  currentDiscordUsername: string;
  discordUserId: string;
  knownDiscordUsernames: string[];
  publicProfileId: string;
  showSocials: boolean;
  socialLinks: PublicSocialLink[];
  submissions: PublicProfileSubmission[];
  submissionCount: number;
  winCount: number;
};

export async function getPublicUserProfileData(
  publicProfileId: string
): Promise<PublicUserProfileData> {
  const { data: userLog, error } = await supabaseServer
    .from("user_logs")
    .select(
      "public_profile_id, discord_user_id, current_discord_username, known_discord_usernames, avatar_key, avatar_updated_at, discord_avatar, show_socials"
    )
    .eq("public_profile_id", publicProfileId)
    .maybeSingle();

  if (error || !userLog) {
    notFound();
  }

  const [submissions, socialLinks] = await Promise.all([
    getUserSubmissions(userLog.discord_user_id),
    getUserSocialLinks(userLog.discord_user_id),
  ]);

  const submissionIds = submissions.map(
    (submission) => submission.id
  );

  const visibilityRowsResult =
    submissionIds.length > 0
      ? await supabaseServer
          .from("submissions")
          .select(
            "id, hidden_from_profile_at, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text"
          )
          .in("id", submissionIds)
      : { data: [], error: null };

  if (visibilityRowsResult.error) {
    console.error(
      "[getPublicUserProfileData][visibility]",
      { code: visibilityRowsResult.error.code }
    );
  }

  const visibilityBySubmissionId = new Map(
    (visibilityRowsResult.data ?? []).map((row) => [
      row.id,
      {
        status: normalizeSubmissionPublicVisibilityStatus(
          row.public_visibility_status
        ),
        reasonCode: row.public_visibility_reason_code,
        reasonText: row.public_visibility_reason_text,
        hiddenFromProfileAt:
          row.hidden_from_profile_at ?? null,
      },
    ])
  );

  const publicSubmissions = submissions
    .map((submission) => {
      if (visibilityRowsResult.error) {
        return null;
      }

      if (submission.is_disqualified) {
        return null;
      }

      const visibility =
        visibilityBySubmissionId.get(submission.id);

      if (!visibility) {
        return null;
      }

      if (visibility.hiddenFromProfileAt) {
        return null;
      }

      if (!isSubmissionListedPublicly(visibility.status)) {
        return null;
      }

      return {
        id: submission.id,
        cycle_id: submission.cycle_id,
        vote_count: submission.vote_count,
        rank: submission.rank,
        total: submission.total,
        tie_count: submission.tie_count,
        destination_href: submission.destination_href,
        image_url: showsSubmissionImagePublicly(
          visibility.status
        )
          ? submission.image_url
          : null,
        public_visibility_status: visibility.status,
        public_visibility_reason_code: visibility.reasonCode,
        public_visibility_reason_text: visibility.reasonText,
      };
    })
    .filter(
      (submission): submission is NonNullable<typeof submission> =>
        submission !== null
    );

  const cycleResults =
    publicSubmissions.length > 0
      ? await supabaseServer
          .from("cycle_results")
          .select("submission_id")
          .in(
            "submission_id",
            publicSubmissions.map((submission) => submission.id)
          )
          .eq("is_winner", true)
      : { data: [], error: null };

  if (cycleResults.error) {
    console.error(
      "[getPublicUserProfileData][cycle_results]",
      cycleResults.error
    );
  }

  const avatarUrl = userLog.avatar_key
    ? getPublicImageUrl(userLog.avatar_key) ?? null
    : userLog.discord_avatar
      ? `https://cdn.discordapp.com/avatars/${userLog.discord_user_id}/${userLog.discord_avatar}.png`
      : null;

  const cacheBustedAvatarUrl =
    avatarUrl && userLog.avatar_updated_at
      ? `${avatarUrl}${
          avatarUrl.includes("?") ? "&" : "?"
        }v=${encodeURIComponent(userLog.avatar_updated_at)}`
      : avatarUrl;

  return {
    avatarUrl: cacheBustedAvatarUrl,
    currentDiscordUsername:
      userLog.current_discord_username ?? "unknown",
    discordUserId: userLog.discord_user_id,
    knownDiscordUsernames:
      userLog.known_discord_usernames ?? [],
    publicProfileId: userLog.public_profile_id,
    showSocials: userLog.show_socials ?? false,
    socialLinks: userLog.show_socials
      ? socialLinks.map((social) => ({
          id: social.id,
          platform: social.platform,
          handle: social.handle,
          profile_url: social.profile_url,
          is_verified: social.is_verified,
        }))
      : [],
    submissions: publicSubmissions,
    submissionCount: publicSubmissions.length,
    winCount: cycleResults.data?.length ?? 0,
  };
}
