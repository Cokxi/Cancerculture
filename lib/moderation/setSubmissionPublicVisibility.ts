import { getActorAuditInfo } from "@/lib/auth/getActorAuditInfo";
import { supabaseAdmin } from "@/lib/db/admin";
import { logModerationAction } from "@/lib/logging/logModerationAction";
import {
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import type { CanonicalTeamRole } from "@/lib/auth/teamRoles";

type SetSubmissionPublicVisibilityParams = {
  actor: {
    discord_user_id: string;
    role: CanonicalTeamRole;
  };
  submissionId: number;
  status: SubmissionPublicVisibilityStatus;
  reasonCode?: string;
  reasonText?: string;
};

export async function setSubmissionPublicVisibility({
  actor,
  submissionId,
  status,
  reasonCode,
  reasonText,
}: SetSubmissionPublicVisibilityParams) {
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, discord_user_id, discord_username_at_upload, public_visibility_source"
    )
    .eq("id", submissionId)
    .single();

  if (!submission) {
    throw new Error("Submission not found");
  }

  const actorAudit = await getActorAuditInfo(actor.discord_user_id);
  const now = new Date().toISOString();

  if (status === SUBMISSION_PUBLIC_VISIBILITY.visible) {
    if (submission.public_visibility_source === "discord_ban") {
      throw Object.assign(
        new Error("DISCORD_BAN_REPUBLISH_REQUIRES_REVIEW"),
        { status: 409 }
      );
    }

    await supabaseAdmin
      .from("submissions")
      .update({
        public_visibility_status:
          SUBMISSION_PUBLIC_VISIBILITY.visible,
        public_visibility_reason_code: null,
        public_visibility_reason_text: null,
        public_visibility_updated_at: now,
        public_visibility_updated_by_discord_user_id:
          actor.discord_user_id,
        public_visibility_updated_by_discord_username:
          actorAudit.username,
      })
      .eq("id", submissionId);

    await logModerationAction({
      actorRole: actor.role,
      actorId: actor.discord_user_id,
      actorUsername: actorAudit.username,
      action: "restore_submission_public_visibility",
      targetType: "submission",
      targetId: submissionId,
      targetDiscordUserId: submission.discord_user_id,
      targetDiscordUsername:
        submission.discord_username_at_upload ?? null,
      cycleId: submission.cycle_id,
      reasonCode: "manual_review",
      evidence: {
        r2_key: submission.r2_key ?? null,
      },
    });

    return;
  }

  await supabaseAdmin
    .from("submissions")
    .update({
      public_visibility_status: status,
      public_visibility_reason_code: reasonCode ?? null,
      public_visibility_reason_text: reasonText ?? null,
      public_visibility_updated_at: now,
      public_visibility_updated_by_discord_user_id:
        actor.discord_user_id,
      public_visibility_updated_by_discord_username:
        actorAudit.username,
    })
    .eq("id", submissionId);

  await logModerationAction({
    actorRole: actor.role,
    actorId: actor.discord_user_id,
    actorUsername: actorAudit.username,
    action:
      status === SUBMISSION_PUBLIC_VISIBILITY.legalReview
        ? "mark_submission_legal_review"
        : "remove_submission_from_public",
    targetType: "submission",
    targetId: submissionId,
    targetDiscordUserId: submission.discord_user_id,
    targetDiscordUsername:
      submission.discord_username_at_upload ?? null,
    cycleId: submission.cycle_id,
    reasonCode,
    reasonText,
    evidence: {
      r2_key: submission.r2_key ?? null,
      public_visibility_status: status,
    },
  });
}
