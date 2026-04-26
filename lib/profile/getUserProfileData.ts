import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { supabaseServer } from "@/lib/db/server";
import { getUserSubmissions } from "@/lib/queries/getUserSubmissions";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getUserSocialLinks } from "@/lib/socials/getUserSocialLinks";
import type { UserSocialLink } from "@/lib/socials/types";
import {
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import {
  getSubmissionPrivateData,
  type SubmissionPrivateData,
} from "@/lib/submissions/getSubmissionPrivateData";

type BaseProfileSubmission = Awaited<
  ReturnType<typeof getUserSubmissions>
>[number];

export type ProfileSubmission = Omit<
  BaseProfileSubmission,
  "image_url"
> & {
  can_hide_from_profile: boolean;
  hidden_from_profile_at: string | null;
  image_url: string | null;
  public_visibility_status: SubmissionPublicVisibilityStatus;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
};

export type ProfileVote = {
  cycle_id: number;
  submission_id: number;
  created_at: string;
  image_url: string | null;
};

export type UserProfileData = {
  activeCycleId: number | null;
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
  currentDiscordUsername: string | null;
  currentSubmissionPrivateData: SubmissionPrivateData | null;
  currentSubmission: ProfileSubmission | null;
  discordUserId: string;
  joinedDate: string | null;
  showSocialsOnProfile: boolean;
  showSocialsOnSubmissions: boolean;
  socialLinks: UserSocialLink[];
  submissions: ProfileSubmission[];
  votes: ProfileVote[];
};

export async function getUserProfileData(
  discordUserId: string
): Promise<UserProfileData> {
  const [
    userLogResult,
    rawSubmissions,
    activeCycle,
    votesResult,
    socialLinks,
  ] =
    await Promise.all([
      supabaseServer
        .from("user_logs")
        .select(
          "first_seen_at, avatar_key, avatar_updated_at, discord_avatar, current_discord_username, show_socials, show_socials_on_submissions"
        )
        .eq("discord_user_id", discordUserId)
        .maybeSingle(),
      getUserSubmissions(discordUserId),
      getActiveCycle(),
      supabaseServer
        .from("votes")
        .select("cycle_id, submission_id, created_at")
        .eq("discord_user_id", discordUserId)
        .order("cycle_id", { ascending: false })
        .order("created_at", { ascending: false }),
      getUserSocialLinks(discordUserId),
    ]);

  const userLog = userLogResult.data;
  const joinedDate = userLog?.first_seen_at
    ? new Date(userLog.first_seen_at).toLocaleDateString("en-GB")
    : null;
  const avatarUrl = userLog?.avatar_key
    ? getPublicImageUrl(userLog.avatar_key) ?? null
    : userLog?.discord_avatar
      ? `https://cdn.discordapp.com/avatars/${discordUserId}/${userLog.discord_avatar}.png`
      : null;
  const avatarUpdatedAt = userLog?.avatar_updated_at ?? null;
  const cacheBustedAvatarUrl =
    avatarUrl && avatarUpdatedAt
      ? `${avatarUrl}${avatarUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(
          avatarUpdatedAt
        )}`
      : avatarUrl;

  const submissionVisibilityResult =
    rawSubmissions.length > 0
      ? await supabaseServer
          .from("submissions")
          .select(
            "id, cycle_id, hidden_from_profile_at, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text"
          )
          .in(
            "id",
            rawSubmissions.map((submission) => submission.id)
          )
      : { data: [], error: null };

  if (submissionVisibilityResult.error) {
    console.error(
      "Failed to load submission visibility:",
      submissionVisibilityResult.error
    );
  }

  const visibilityBySubmissionId = new Map(
    (submissionVisibilityResult.data ?? []).map((row) => [
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

  const cycleIds = Array.from(
    new Set(rawSubmissions.map((submission) => submission.cycle_id))
  );
  const cycleRowsResult =
    cycleIds.length > 0
      ? await supabaseServer
          .from("voting_cycles")
          .select("id, status")
          .in("id", cycleIds)
      : { data: [], error: null };

  if (cycleRowsResult.error) {
    console.error(
      "Failed to load submission cycles:",
      cycleRowsResult.error
    );
  }

  const cycleStatusById = new Map(
    (cycleRowsResult.data ?? []).map((cycle) => [
      cycle.id,
      cycle.status,
    ])
  );

  const submissions: ProfileSubmission[] = rawSubmissions.flatMap(
    (submission): ProfileSubmission[] => {
      const visibility =
        visibilityBySubmissionId.get(submission.id) ?? {
          status: normalizeSubmissionPublicVisibilityStatus(
            null
          ),
          reasonCode: null,
          reasonText: null,
          hiddenFromProfileAt: null,
        };

      if (visibility.hiddenFromProfileAt) {
        return [];
      }

      return [
        {
          ...submission,
          can_hide_from_profile:
            submission.is_disqualified &&
            cycleStatusById.get(submission.cycle_id) ===
              "finished",
          hidden_from_profile_at:
            visibility.hiddenFromProfileAt,
          image_url: showsSubmissionImagePublicly(
            visibility.status
          )
            ? submission.image_url
            : null,
          public_visibility_status: visibility.status,
          public_visibility_reason_code: visibility.reasonCode,
          public_visibility_reason_text: visibility.reasonText,
        },
      ];
    }
  );

  const voteRows = votesResult.data ?? [];
  const submissionIds = Array.from(
    new Set(voteRows.map((vote) => vote.submission_id))
  );

  const voteSubmissionsResult =
    submissionIds.length > 0
      ? await supabaseServer
          .from("submissions")
          .select("id, r2_key, public_visibility_status")
          .in("id", submissionIds)
      : { data: [], error: null };

  if (voteSubmissionsResult.error) {
    console.error(
      "Failed to load voted submissions:",
      voteSubmissionsResult.error
    );
  }

  const voteSubmissionMap = new Map(
    (voteSubmissionsResult.data ?? []).map((submission) => {
      const visibilityStatus =
        normalizeSubmissionPublicVisibilityStatus(
          submission.public_visibility_status
        );

      return [
        submission.id,
        showsSubmissionImagePublicly(visibilityStatus)
          ? getPublicImageUrl(submission.r2_key) ?? null
          : null,
      ];
    })
  );

  const votes: ProfileVote[] = voteRows.map((vote) => ({
    cycle_id: vote.cycle_id,
    submission_id: vote.submission_id,
    created_at: vote.created_at,
    image_url: voteSubmissionMap.get(vote.submission_id) ?? null,
  }));

  const activeCycleId = activeCycle?.id ?? null;
  const currentSubmission = activeCycleId
    ? submissions.find(
        (submission) => submission.cycle_id === activeCycleId
      ) ?? null
    : null;
  const currentSubmissionPrivateData = currentSubmission
    ? await getSubmissionPrivateData(currentSubmission.id)
    : null;

  return {
    activeCycleId,
    avatarUrl: cacheBustedAvatarUrl,
    avatarUpdatedAt,
    currentDiscordUsername:
      userLog?.current_discord_username ?? null,
    currentSubmissionPrivateData,
    currentSubmission,
    discordUserId,
    joinedDate,
    showSocialsOnProfile: userLog?.show_socials ?? false,
    showSocialsOnSubmissions:
      userLog?.show_socials_on_submissions ?? false,
    socialLinks,
    submissions,
    votes,
  };
}
