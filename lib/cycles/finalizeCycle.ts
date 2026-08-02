import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type FinalizeCycleResult = {
  cycleId: number;
  finalStatus: "finished";
  rankedSubmissionCount: number;
  winnerCount: number;
  highestRank: number;
  alreadyFinalized: boolean;
};

const CONFLICT_MESSAGES = new Set([
  "CYCLE_NOT_FOUND",
  "FINALIZED_RESULT_SNAPSHOT_INCOMPLETE",
  "INVALID_CYCLE_ID",
  "INVALID_CYCLE_STATE",
  "INVALID_FINALIZATION_ACTOR",
  "NO_COMPETITION_ELIGIBLE_SUBMISSIONS",
  "NO_FINALIZATION_WINNER",
  "WINNER_PRIVATE_DATA_MISSING",
]);

function isFinalizeCycleResult(
  value: unknown
): value is FinalizeCycleResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    typeof result.cycleId === "number" &&
    result.finalStatus === "finished" &&
    typeof result.rankedSubmissionCount === "number" &&
    typeof result.winnerCount === "number" &&
    typeof result.highestRank === "number" &&
    typeof result.alreadyFinalized === "boolean"
  );
}

export async function finalizeCycleTransactional({
  actorDiscordUserId,
  cycleId,
}: {
  actorDiscordUserId: string;
  cycleId: number;
}): Promise<FinalizeCycleResult> {
  const { data, error } = await supabaseAdmin.rpc(
    "finalize_cycle_managed",
    {
      p_actor_discord_user_id: actorDiscordUserId,
      p_cycle_id: cycleId,
    }
  );

  if (error) {
    const knownConflict = Array.from(CONFLICT_MESSAGES).find(
      (message) => error.message.includes(message)
    );

    if (knownConflict) {
      throw Object.assign(new Error(knownConflict), {
        status: 409,
      });
    }

    console.error("[cycle finalization][rpc]", error);
    throw new Error("Cycle finalization failed");
  }

  if (!isFinalizeCycleResult(data)) {
    console.error(
      "[cycle finalization][invalid response]",
      data
    );
    throw new Error("Cycle finalization returned an invalid response");
  }

  return data;
}
