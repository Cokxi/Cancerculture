import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";

export type CyclePrizePoolManagementContext = Readonly<{
  cycleId: number;
  cycleNumber: number | null;
  cycleStatus: string;
  pausedFromStatus: string | null;
  votingEndsAt: string | null;
  databaseTime: string;
  editable: boolean;
  rowVersion: number;
  amountLamports: string | null;
}>;

export type SaveCyclePrizePoolResult = Readonly<{
  cycleId: number;
  rowVersion: number;
  amountLamports: string;
  replayed: boolean;
}>;

export class CyclePrizePoolError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CyclePrizePoolError";
    this.status = status;
    this.code = code;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rpcError(error: { message: string; code?: string }): never {
  const message = error.message ?? "";

  if (message.includes("CYCLE_MANAGEMENT_FORBIDDEN")) {
    throw new CyclePrizePoolError(403, "FORBIDDEN", "Forbidden");
  }
  if (message.includes("CYCLE_PRIZE_POOL_CONFIRMATION_INVALID")) {
    throw new CyclePrizePoolError(
      400,
      "CONFIRMATION_INVALID",
      "Enter the exact same SOL amount in both fields."
    );
  }
  if (
    message.includes("CYCLE_PRIZE_POOL_DEADLINE_PASSED") ||
    message.includes("CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN")
  ) {
    throw new CyclePrizePoolError(
      409,
      "DEADLINE_PASSED",
      "The prize pool can no longer be added or changed because voting has ended."
    );
  }
  if (
    message.includes("CYCLE_PRIZE_POOL_STATE_CHANGED") ||
    message.includes("CYCLE_PRIZE_POOL_REQUEST_REUSED") ||
    message.includes("CYCLE_PRIZE_POOL_CYCLE_NOT_FOUND")
  ) {
    throw new CyclePrizePoolError(
      409,
      "STATE_CHANGED",
      "The Cycle changed. Refresh the page and try again."
    );
  }

  console.error("[cycle prize pool][rpc]", { code: error.code });
  throw new CyclePrizePoolError(
    503,
    "UNAVAILABLE",
    "Prize pool management is temporarily unavailable."
  );
}

export async function getCyclePrizePoolManagementContext(
  actorDiscordUserId: string,
  cycleId: number
): Promise<CyclePrizePoolManagementContext> {
  const { data, error } = await supabaseAdmin.rpc(
    "get_cycle_prize_pool_management_context",
    {
      p_actor_discord_user_id: actorDiscordUserId,
      p_cycle_id: cycleId,
    }
  );
  if (error) rpcError(error);

  const context = objectValue(data);
  if (
    context.outcome !== "ok" ||
    typeof context.cycleId !== "number" ||
    typeof context.cycleStatus !== "string" ||
    typeof context.databaseTime !== "string" ||
    typeof context.editable !== "boolean" ||
    typeof context.rowVersion !== "number" ||
    (context.cycleNumber !== null &&
      typeof context.cycleNumber !== "number") ||
    (context.pausedFromStatus !== null &&
      typeof context.pausedFromStatus !== "string") ||
    (context.votingEndsAt !== null &&
      typeof context.votingEndsAt !== "string") ||
    (context.amountLamports !== null &&
      (typeof context.amountLamports !== "string" ||
        !/^[0-9]+$/u.test(context.amountLamports)))
  ) {
    throw new CyclePrizePoolError(
      503,
      "INVALID_RESPONSE",
      "Prize pool management returned an invalid response."
    );
  }

  return Object.freeze({
    cycleId: context.cycleId,
    cycleNumber: context.cycleNumber,
    cycleStatus: context.cycleStatus,
    pausedFromStatus: context.pausedFromStatus,
    votingEndsAt: context.votingEndsAt,
    databaseTime: context.databaseTime,
    editable: context.editable,
    rowVersion: context.rowVersion,
    amountLamports: context.amountLamports,
  });
}

export async function saveCurrentCyclePrizePool(input: {
  actorDiscordUserId: string;
  requestId: string;
  cycleId: number;
  expectedVersion: number;
  amountLamports: bigint;
  confirmedAmountLamports: bigint;
}): Promise<SaveCyclePrizePoolResult> {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_current_cycle_prize_pool",
    {
      p_actor_discord_user_id: input.actorDiscordUserId,
      p_request_id: input.requestId,
      p_cycle_id: input.cycleId,
      p_expected_version: input.expectedVersion,
      p_amount_lamports: input.amountLamports.toString(),
      p_confirmed_amount_lamports:
        input.confirmedAmountLamports.toString(),
    }
  );
  if (error) rpcError(error);

  const result = objectValue(data);
  if (
    result.outcome !== "saved" ||
    typeof result.cycleId !== "number" ||
    typeof result.rowVersion !== "number" ||
    typeof result.amountLamports !== "string" ||
    !/^[0-9]+$/u.test(result.amountLamports) ||
    typeof result.replayed !== "boolean"
  ) {
    throw new CyclePrizePoolError(
      503,
      "INVALID_RESPONSE",
      "Prize pool management returned an invalid response."
    );
  }

  return Object.freeze({
    cycleId: result.cycleId,
    rowVersion: result.rowVersion,
    amountLamports: result.amountLamports,
    replayed: result.replayed,
  });
}
