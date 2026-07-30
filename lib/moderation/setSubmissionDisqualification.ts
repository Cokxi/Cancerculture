import { getActorAuditInfo } from "@/lib/auth/getActorAuditInfo";
import { supabaseAdmin } from "@/lib/db/admin";
import { logModerationAction } from "@/lib/logging/logModerationAction";
import type { CanonicalTeamRole } from "@/lib/auth/teamRoles";

type SetSubmissionDisqualificationParams = {
  actor: {
    discord_user_id: string;
    role: CanonicalTeamRole;
  };
  submissionId: number;
  mode: "disqualify" | "reinstate";
  disqualificationType?: string;
  reasonCode?: string;
  reasonText?: string;
};

export async function setSubmissionDisqualification({
  actor,
  submissionId,
  mode,
  disqualificationType,
  reasonCode,
  reasonText,
}: SetSubmissionDisqualificationParams) {
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("id, cycle_id, r2_key, discord_user_id")
    .eq("id", submissionId)
    .single();

  if (!submission) {
    throw new Error("Submission not found");
  }

  const { data: cycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("status, paused_from_status")
    .eq("id", submission.cycle_id)
    .single();
  const canUseActiveModeration =
    cycle?.status === "active" ||
    cycle?.status === "submission_open" ||
    (cycle?.status === "paused" &&
      cycle.paused_from_status === "submission_open");

  if (!canUseActiveModeration) {
    throw Object.assign(
      new Error(
        "Submission disqualification is only available during the submission phase"
      ),
      { status: 409 }
    );
  }

  const actorAudit = await getActorAuditInfo(actor.discord_user_id);

  if (mode === "disqualify") {
    await supabaseAdmin
      .from("submissions")
      .update({
        is_disqualified: true,
        disqualification_type: disqualificationType ?? null,
        disqualification_reason_code: reasonCode ?? null,
        disqualification_reason_text: reasonText ?? null,
        disqualified_at: new Date().toISOString(),
        disqualified_by_discord_user_id: actor.discord_user_id,
        disqualified_by_discord_username: actorAudit.username,
      })
      .eq("id", submissionId);

    await logModerationAction({
      actorRole: actor.role,
      actorId: actor.discord_user_id,
      actorUsername: actorAudit.username,
      action: "disqualify_submission",
      targetType: "submission",
      targetId: submissionId,
      cycleId: submission.cycle_id,
      reasonCode,
      reasonText,
      evidence: {
        r2_key: submission.r2_key ?? null,
      },
    });

    return;
  }

  await supabaseAdmin
    .from("submissions")
    .update({
      is_disqualified: false,
      disqualification_type: null,
      disqualification_reason_code: null,
      disqualification_reason_text: null,
    })
    .eq("id", submissionId);

  await logModerationAction({
    actorRole: actor.role,
    actorId: actor.discord_user_id,
    actorUsername: actorAudit.username,
    action: "reinstate_submission",
    targetType: "submission",
    targetId: submissionId,
    cycleId: submission.cycle_id,
    reasonCode: "manual_review",
    evidence: {
      r2_key: submission.r2_key,
    },
  });
}
