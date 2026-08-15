import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";

export type CycleManagementOperation =
  | "end_submission_start_voting"
  | "start_voting"
  | "end_voting"
  | "set_timer"
  | "clear_timer"
  | "set_votes_per_user"
  | "pause"
  | "resume";

export type CycleManagementResult = Readonly<{
  operation: CycleManagementOperation;
  requestId: string;
  cycleId: number;
  previousStatus: string;
  status: string;
  replayed: boolean;
}>;

const CONFLICT_CODES = [
  "CYCLE_MANAGEMENT_IDEMPOTENCY_CONFLICT",
  "CYCLE_MANAGEMENT_STATE_CONFLICT",
  "CYCLE_MANAGEMENT_CYCLE_NOT_FOUND",
] as const;

function isCycleManagementResult(
  value: unknown
): value is CycleManagementResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;

  return (
    [
      "end_submission_start_voting",
      "start_voting",
      "end_voting",
      "set_timer",
      "clear_timer",
      "set_votes_per_user",
      "pause",
      "resume",
    ].includes(String(result.operation)) &&
    typeof result.requestId === "string" &&
    typeof result.cycleId === "number" &&
    typeof result.previousStatus === "string" &&
    typeof result.status === "string" &&
    typeof result.replayed === "boolean"
  );
}

export async function manageCyclePhase(params: {
  actorDiscordUserId: string;
  cycleId: number;
  operation: CycleManagementOperation;
  expectedStatus: string;
  durationMinutes?: number | null;
  votesPerUser?: number | null;
  reason?: string | null;
  idempotencyKey: string;
}): Promise<CycleManagementResult> {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_cycle_phase",
    {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_cycle_id: params.cycleId,
      p_operation: params.operation,
      p_expected_status: params.expectedStatus,
      p_duration_minutes: params.durationMinutes ?? null,
      p_votes_per_user: params.votesPerUser ?? null,
      p_reason: params.reason ?? null,
      p_idempotency_key: params.idempotencyKey,
    }
  );

  if (error) {
    const message = error.message ?? "";

    if (message.includes("CYCLE_MANAGEMENT_FORBIDDEN")) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }

    const conflict = CONFLICT_CODES.find((code) =>
      message.includes(code)
    );
    if (conflict) {
      throw Object.assign(
        new Error("The cycle state changed. Refresh and try again."),
        { status: 409, code: conflict }
      );
    }

    if (message.includes("INVALID_CYCLE_MANAGEMENT_REQUEST")) {
      throw Object.assign(new Error("Invalid cycle management request"), {
        status: 400,
      });
    }

    console.error("[cycle management][rpc]", { code: error.code });
    throw Object.assign(
      new Error("Cycle management is temporarily unavailable"),
      { status: 503 }
    );
  }

  if (!isCycleManagementResult(data)) {
    console.error("[cycle management][invalid response]");
    throw Object.assign(
      new Error("Cycle management returned an invalid response"),
      { status: 503 }
    );
  }

  return Object.freeze(data);
}
