import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

type RepublishResult = {
  outcome: "republished" | "already_republished";
  submissionId: number;
  competitionDisqualified: boolean;
};

export async function republishDiscordBanSubmission({
  actorDiscordUserId,
  manualReviewConfirmed,
  reason,
  submissionId,
}: {
  actorDiscordUserId: string;
  manualReviewConfirmed: boolean;
  reason: string;
  submissionId: number;
}): Promise<RepublishResult> {
  const { data, error } = await supabaseAdmin.rpc(
    "republish_discord_ban_submission",
    {
      p_actor_discord_user_id: actorDiscordUserId,
      p_manual_review_confirmed: manualReviewConfirmed,
      p_reason: reason,
      p_submission_id: submissionId,
    }
  );

  if (error) {
    const knownErrors = [
      "INVALID_SUBMISSION_ID",
      "REPUBLISH_REASON_REQUIRED",
      "MANUAL_REVIEW_CONFIRMATION_REQUIRED",
      "DISCORD_BAN_STILL_ACTIVE",
      "MEMBERSHIP_STATE_MISSING",
      "SUBMISSION_NOT_FOUND",
      "SUBMISSION_NOT_DISCORD_BAN_HIDDEN",
    ];
    const knownError = knownErrors.find((code) =>
      error.message.includes(code)
    );

    if (knownError) {
      throw Object.assign(new Error(knownError), {
        status:
          knownError === "SUBMISSION_NOT_FOUND"
            ? 404
            : knownError === "DISCORD_BAN_STILL_ACTIVE" ||
                knownError === "SUBMISSION_NOT_DISCORD_BAN_HIDDEN"
              ? 409
              : 400,
      });
    }

    console.error("[discord ban republish][rpc]", {
      code: error.code,
    });
    throw Object.assign(
      new Error("REPUBLISH_DEPENDENCY_UNAVAILABLE"),
      { status: 503 }
    );
  }

  if (
    !data ||
    typeof data !== "object" ||
    !("outcome" in data) ||
    (data.outcome !== "republished" &&
      data.outcome !== "already_republished") ||
    !("submissionId" in data) ||
    typeof data.submissionId !== "number" ||
    !("competitionDisqualified" in data) ||
    typeof data.competitionDisqualified !== "boolean"
  ) {
    throw Object.assign(new Error("INVALID_REPUBLISH_RESPONSE"), {
      status: 503,
    });
  }

  return data as RepublishResult;
}
