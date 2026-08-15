import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";
import type {
  SubmissionModerationOperation,
  SubmissionModerationPhase,
} from "@/lib/moderation/submissionModerationAuthorization";

export class SubmissionModerationError extends Error {
  readonly status: 403 | 409 | 422 | 503;
  readonly code: string;

  constructor(
    status: 403 | 409 | 422 | 503,
    message: string,
    code: string
  ) {
    super(message);
    this.name = "SubmissionModerationError";
    this.status = status;
    this.code = code;
  }
}

export type SubmissionModerationResult = Readonly<{
  operation: SubmissionModerationOperation;
  requestId: string;
  cycleId: number;
  submissionId: number;
  phase: SubmissionModerationPhase;
  requiredCapability: string;
  changed: boolean;
  isDisqualified: boolean;
  replayed: boolean;
}>;

type RpcFailureContext = Readonly<{
  requestId: string;
  operation: SubmissionModerationOperation;
  startedAt: number;
}>;

function logRpcDependencyFailure(
  error: { code?: string; message?: string },
  context: RpcFailureContext
) {
  const databaseCode = error.code ?? null;
  console.error("[SUBMISSION_MODERATION] RPC failed", {
    requestId: context.requestId,
    operation: context.operation,
    durationMs: Math.round(performance.now() - context.startedAt),
    errorClass:
      databaseCode === null
        ? "transport"
        : databaseCode.startsWith("PGRST")
          ? "postgrest"
          : "database-contract",
    databaseCode,
  });
}

function mapRpcError(
  error: { code?: string; message?: string },
  context: RpcFailureContext
) {
  const message = error.message ?? "";
  if (message.includes("SUBMISSION_MODERATION_FORBIDDEN")) {
    return new SubmissionModerationError(
      403,
      "You are not authorized for this moderation action.",
      "SUBMISSION_MODERATION_FORBIDDEN"
    );
  }

  for (const code of [
    "SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT",
    "MODERATION_CYCLE_NOT_FOUND",
    "MODERATION_PHASE_CLOSED",
    "MODERATION_PHASE_CONFLICT",
    "MODERATION_SUBMISSION_NOT_FOUND",
    "MODERATION_SUBMISSION_CYCLE_CONFLICT",
    "MODERATION_EXPECTED_STATE_CONFLICT",
    "VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED",
  ]) {
    if (message.includes(code)) {
      return new SubmissionModerationError(
        409,
        code === "VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED"
          ? "This submission cannot be reinstated because its votes were refunded."
          : "The moderation state changed. Refresh and try again.",
        code
      );
    }
  }

  if (
    message.includes("INVALID_SUBMISSION_MODERATION_REQUEST") ||
    message.includes("REINSTATE_REASON_REQUIRED") ||
    message.includes("INVALID_REINSTATE_DISQUALIFICATION_TYPE")
  ) {
    return new SubmissionModerationError(
      422,
      "The moderation request is invalid.",
      "INVALID_SUBMISSION_MODERATION_REQUEST"
    );
  }

  logRpcDependencyFailure(error, context);
  return new SubmissionModerationError(
    503,
    "Submission moderation is temporarily unavailable.",
    "SUBMISSION_MODERATION_UNAVAILABLE"
  );
}

function isResult(
  value: unknown
): value is SubmissionModerationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    (result.operation === "disqualify" ||
      result.operation === "reinstate") &&
    typeof result.requestId === "string" &&
    typeof result.cycleId === "number" &&
    typeof result.submissionId === "number" &&
    (result.phase === "submission_open" ||
      result.phase === "voting_open" ||
      result.phase === "voting_closed") &&
    typeof result.requiredCapability === "string" &&
    typeof result.changed === "boolean" &&
    typeof result.isDisqualified === "boolean" &&
    typeof result.replayed === "boolean"
  );
}

export async function moderateSubmission(params: {
  actorDiscordUserId: string;
  cycleId: number;
  submissionId: number;
  operation: SubmissionModerationOperation;
  expectedPhase: SubmissionModerationPhase;
  expectedIsDisqualified: boolean;
  disqualificationType: string | null;
  reasonCode: string;
  reasonText: string | null;
  idempotencyKey: string;
}): Promise<SubmissionModerationResult> {
  assertServerMutationAllowed();
  const context: RpcFailureContext = {
    requestId: params.idempotencyKey,
    operation: params.operation,
    startedAt: performance.now(),
  };
  let response;
  try {
    response = await supabaseAdmin.rpc(
      params.expectedPhase === "voting_closed"
        ? "moderate_cycle_end_submission"
        : "moderate_submission",
      {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_cycle_id: params.cycleId,
      p_submission_id: params.submissionId,
      p_operation: params.operation,
      p_expected_phase: params.expectedPhase,
      p_expected_is_disqualified:
        params.expectedIsDisqualified,
      p_disqualification_type: params.disqualificationType,
      p_reason_code: params.reasonCode,
      p_reason_text: params.reasonText,
      p_idempotency_key: params.idempotencyKey,
      }
    );
  } catch {
    logRpcDependencyFailure({}, context);
    throw new SubmissionModerationError(
      503,
      "Submission moderation is temporarily unavailable.",
      "SUBMISSION_MODERATION_UNAVAILABLE"
    );
  }

  const { data, error } = response;

  if (error) throw mapRpcError(error, context);
  if (!isResult(data)) {
    throw new SubmissionModerationError(
      503,
      "Submission moderation returned an invalid response.",
      "INVALID_SUBMISSION_MODERATION_RESPONSE"
    );
  }

  return Object.freeze(data);
}
