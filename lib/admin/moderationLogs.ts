import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { getDelegatedSubmissionModerationReason } from "@/lib/admin/submissionModerationLogAccess";
import {
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
} from "@/lib/moderation/submissionPublicVisibility";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";

export const SUBMISSION_MODERATION_LOG_ACTIONS = Object.freeze([
  "disqualify_submission",
  "reinstate_submission",
  "mark_submission_legal_review",
  "restore_submission_public_visibility",
  "remove_submission_from_public",
] as const);

export type ModerationLogRow = {
  id: string;
  created_at: string;
  actor_role: string;
  actor_discord_user_id: string;
  actor_discord_user_label: string | null;
  actor_public_profile_id: string | null;
  action: string;
  submission_id: number | null;
  submission_href: string | null;
  submission_thumbnail_url: string | null;
  submitter_discord_user_id: string | null;
  submitter_discord_user_label: string | null;
  submitter_public_profile_id: string | null;
  reason: string;
  reason_text: string | null;
  cycle_id: number | null;
};

type ModerationLogQueryRow = {
  id: string;
  created_at: string;
  actor_role: string;
  actor_id: string;
  action: string;
  target_id: string;
  target_discord_user_id: string | null;
  reason_code: string;
  reason_text?: string | null;
  cycle_id: number | null;
};

type SubmissionLinkQueryRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  is_disqualified: boolean | null;
  public_visibility_status: string | null;
};

export async function getSubmissionModerationLogs({
  includeAdminDetails = false,
}: {
  includeAdminDetails?: boolean;
} = {}) {
  const query = includeAdminDetails
    ? supabaseAdmin
        .from("moderation_action_logs")
        .select(
          "id, created_at, actor_role, actor_id, action, target_id, target_discord_user_id, reason_code, reason_text, cycle_id"
        )
    : supabaseAdmin
        .from("moderation_action_logs")
        .select(
          "id, created_at, actor_role, actor_id, action, target_id, target_discord_user_id, reason_code, cycle_id"
        );

  const { data, error } = await query
    .eq("target_type", "submission")
    .in("action", [...SUBMISSION_MODERATION_LOG_ACTIONS])
    .order("created_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    return { data: [], error };
  }

  const rows = data as ModerationLogQueryRow[];
  const discordUserIds = Array.from(
    new Set(
      rows.flatMap((log) =>
        [log.actor_id, log.target_discord_user_id].filter(
          (discordUserId): discordUserId is string =>
            typeof discordUserId === "string" && discordUserId.length > 0
        )
      )
    )
  );

  const submissionIds = Array.from(
    new Set(
      rows
        .map((log) => Number(log.target_id))
        .filter(
          (submissionId) =>
            Number.isSafeInteger(submissionId) && submissionId > 0
        )
    )
  );
  const [usersResult, submissionsResult] = await Promise.all([
    discordUserIds.length > 0
      ? supabaseAdmin
          .from("user_logs")
          .select(
            "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
          )
          .in("discord_user_id", discordUserIds)
      : Promise.resolve({ data: [], error: null }),
    submissionIds.length > 0
      ? supabaseAdmin
          .from("submissions")
          .select(
            "id, cycle_id, r2_key, is_disqualified, public_visibility_status"
          )
          .in("id", submissionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const submissions = submissionsResult.error
    ? []
    : ((submissionsResult.data ?? []) as SubmissionLinkQueryRow[]);
  const cycleIds = Array.from(
    new Set(submissions.map((submission) => submission.cycle_id))
  );
  const cyclesResult =
    cycleIds.length > 0
      ? await supabaseAdmin
          .from("voting_cycles")
          .select("id, status")
          .in("id", cycleIds)
      : { data: [], error: null };
  const cycleStatusById = new Map(
    cyclesResult.error
      ? []
      : (cyclesResult.data ?? []).map((cycle) => [
          cycle.id,
          cycle.status,
        ])
  );
  const submissionById = new Map(
    submissions.map((submission) => [submission.id, submission])
  );

  const userByDiscordUserId = new Map(
    (usersResult.data ?? []).map((user) => [
      user.discord_user_id,
      {
        label: formatDiscordUserLabel(user, "admin"),
        publicProfileId: user.public_profile_id,
      },
    ])
  );

  return {
    data: rows.map((log): ModerationLogRow => {
      const actor = userByDiscordUserId.get(log.actor_id);
      const submitter = log.target_discord_user_id
        ? userByDiscordUserId.get(log.target_discord_user_id)
        : null;
      const parsedSubmissionId = Number(log.target_id);
      const submission = Number.isSafeInteger(parsedSubmissionId)
        ? submissionById.get(parsedSubmissionId)
        : null;
      const submissionHref = submission
        ? getSubmissionDestinationHref({
            cycleId: submission.cycle_id,
            cycleStatus: cycleStatusById.get(submission.cycle_id),
            isDisqualified: submission.is_disqualified,
            publicVisibilityStatus:
              submission.public_visibility_status,
            submissionId: submission.id,
          })
        : null;
      const publicImageUrl =
        submissionHref &&
        submission &&
        showsSubmissionImagePublicly(
          normalizeSubmissionPublicVisibilityStatus(
            submission.public_visibility_status
          )
        )
          ? getPublicImageUrl(submission.r2_key)
          : null;

      return {
        id: log.id,
        created_at: log.created_at,
        actor_role: log.actor_role,
        actor_discord_user_id: log.actor_id,
        actor_discord_user_label: actor?.label ?? null,
        actor_public_profile_id: actor?.publicProfileId ?? null,
        action: log.action,
        submission_id: Number.isSafeInteger(parsedSubmissionId)
          ? parsedSubmissionId
          : null,
        submission_href: submissionHref,
        submission_thumbnail_url: publicImageUrl
          ? getSubmissionThumbnailUrl(publicImageUrl)
          : null,
        submitter_discord_user_id: log.target_discord_user_id,
        submitter_discord_user_label: submitter?.label ?? null,
        submitter_public_profile_id: submitter?.publicProfileId ?? null,
        reason: includeAdminDetails
          ? log.reason_code
          : getDelegatedSubmissionModerationReason(log.reason_code),
        reason_text: includeAdminDetails ? log.reason_text ?? null : null,
        cycle_id: log.cycle_id,
      };
    }),
    error: null,
  };
}
