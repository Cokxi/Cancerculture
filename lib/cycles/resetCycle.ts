import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type ResetCycleResult = {
  cycleId: number;
  cycleNumber: number;
  previousStatus: string;
  status: "draft";
  removedSubmissions: number;
  removedVotes: number;
  affectedSubmitters: number;
  removedResults: number;
  removedWinnerRows: number;
  r2KeysPendingCleanup: number;
  r2CleanupQueueIds: number[];
  alreadyReset: boolean;
  resetCount: number;
};

const BAD_REQUEST_MESSAGES = new Set([
  "INVALID_CYCLE_ID",
  "INVALID_RESET_ACTOR",
  "RESET_REASON_REQUIRED",
  "RESET_REASON_TOO_LONG",
]);

const IMMUTABLE_MODERATION_HISTORY_CONSTRAINTS = [
  "submission_disqualification_events_submission_id_fkey",
  "user_flag_cases_submission_id_fkey",
] as const;

function isResetCycleResult(value: unknown): value is ResetCycleResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    typeof result.cycleId === "number" &&
    typeof result.cycleNumber === "number" &&
    typeof result.previousStatus === "string" &&
    result.status === "draft" &&
    typeof result.removedSubmissions === "number" &&
    typeof result.removedVotes === "number" &&
    typeof result.affectedSubmitters === "number" &&
    typeof result.removedResults === "number" &&
    typeof result.removedWinnerRows === "number" &&
    typeof result.r2KeysPendingCleanup === "number" &&
    Array.isArray(result.r2CleanupQueueIds) &&
    result.r2CleanupQueueIds.every(
      (queueId) => typeof queueId === "number"
    ) &&
    typeof result.alreadyReset === "boolean" &&
    typeof result.resetCount === "number"
  );
}

export async function resetCycleTransactional({
  actorDiscordUserId,
  cycleId,
  reason,
}: {
  actorDiscordUserId: string;
  cycleId: number;
  reason: string;
}): Promise<ResetCycleResult> {
  const { data, error } = await supabaseAdmin.rpc("reset_cycle_managed", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_cycle_id: cycleId,
    p_reason: reason,
  });

  if (error) {
    const badRequest = Array.from(BAD_REQUEST_MESSAGES).find(
      (message) => error.message.includes(message)
    );

    if (badRequest) {
      throw Object.assign(new Error(badRequest), { status: 400 });
    }

    if (error.message.includes("CYCLE_NOT_FOUND")) {
      throw Object.assign(new Error("Cycle not found"), {
        status: 404,
      });
    }

    if (error.message.includes("CYCLE_STATE_NOT_RESETTABLE")) {
      throw Object.assign(
        new Error("Cycle state cannot be reset"),
        { status: 409 }
      );
    }

    const dependencyContext = `${error.message} ${error.details ?? ""}`;
    if (
      error.code === "23503" &&
      IMMUTABLE_MODERATION_HISTORY_CONSTRAINTS.some((constraint) =>
        dependencyContext.includes(constraint)
      )
    ) {
      throw Object.assign(
        new Error(
          "Cycle contains immutable moderation history and cannot be reset"
        ),
        { status: 409 }
      );
    }

    console.error("[cycle reset][rpc]", {
      code: error.code ?? "UNKNOWN",
    });
    throw Object.assign(new Error("Cycle reset failed"), {
      status: 503,
    });
  }

  if (!isResetCycleResult(data)) {
    console.error("[cycle reset][invalid response]");
    throw new Error("Cycle reset returned an invalid response");
  }

  return data;
}
