import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";
import type { VoteRefundSelection } from "@/lib/voteRefund/request";

export type VoteRefundSubmissionResult = Readonly<{
  submissionId: number;
  refundedVoteCount: number;
}>;

export type VoteRefundResult = Readonly<{
  requestId: string;
  cycleId: number;
  resetCount: number;
  votesPerUser: number;
  selectionCount: number;
  refundedVoteCount: number;
  affectedVoterCount: number;
  submissionRefunds: readonly VoteRefundSubmissionResult[];
  replayed: boolean;
}>;

function refundUnavailable() {
  return new AuthError(
    503,
    "Vote refunds are temporarily unavailable",
    "VOTE_REFUND_UNAVAILABLE"
  );
}

function mapRpcError(error: { code?: string; message?: string }) {
  const message = error.message ?? "";

  if (message.includes("VOTE_REFUND_FORBIDDEN")) {
    return new AuthError(403, "Forbidden", "VOTE_REFUND_FORBIDDEN");
  }

  if (message.includes("VOTE_REFUND_LIMIT_EXCEEDED")) {
    return new AuthError(
      413,
      "Vote-refund selection is too large",
      "VOTE_REFUND_LIMIT_EXCEEDED"
    );
  }

  if (message.includes("INVALID_VOTE_REFUND_REQUEST")) {
    return new AuthError(
      422,
      "Invalid vote-refund request",
      "INVALID_VOTE_REFUND_REQUEST"
    );
  }

  for (const code of [
    "VOTE_REFUND_IDEMPOTENCY_CONFLICT",
    "VOTE_REFUND_CYCLE_NOT_FOUND",
    "VOTE_REFUND_PHASE_CLOSED",
    "VOTE_REFUND_CYCLE_ATTEMPT_CONFLICT",
    "VOTE_REFUND_VOTE_LIMIT_CONFLICT",
    "VOTE_REFUND_SUBMISSION_NOT_FOUND",
    "VOTE_REFUND_SUBMISSION_CYCLE_CONFLICT",
    "VOTE_REFUND_SUBMISSION_NOT_DISQUALIFIED",
    "VOTE_REFUND_DISQUALIFICATION_CONFLICT",
    "VOTE_REFUND_COUNT_CONFLICT",
    "VOTE_REFUND_NOTHING_TO_REFUND",
  ]) {
    if (message.includes(code)) {
      return new AuthError(
        409,
        "Vote-refund state changed",
        code
      );
    }
  }

  console.error("[VOTE_REFUND] RPC failed", {
    databaseCode: error.code ?? null,
  });
  return refundUnavailable();
}

function parseSubmissionRefunds(
  value: unknown
): readonly VoteRefundSubmissionResult[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: VoteRefundSubmissionResult[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.submissionId) ||
      Number(row.submissionId) <= 0 ||
      !Number.isSafeInteger(row.refundedVoteCount) ||
      Number(row.refundedVoteCount) <= 0
    ) {
      return null;
    }
    parsed.push(
      Object.freeze({
        submissionId: Number(row.submissionId),
        refundedVoteCount: Number(row.refundedVoteCount),
      })
    );
  }

  return Object.freeze(parsed);
}

function parseResult(value: unknown): VoteRefundResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const submissionRefunds = parseSubmissionRefunds(result.submissionRefunds);

  if (
    typeof result.requestId !== "string" ||
    !Number.isSafeInteger(result.cycleId) ||
    !Number.isSafeInteger(result.resetCount) ||
    !Number.isSafeInteger(result.votesPerUser) ||
    !Number.isSafeInteger(result.selectionCount) ||
    !Number.isSafeInteger(result.refundedVoteCount) ||
    !Number.isSafeInteger(result.affectedVoterCount) ||
    !submissionRefunds ||
    typeof result.replayed !== "boolean"
  ) {
    return null;
  }

  return Object.freeze({
    requestId: result.requestId,
    cycleId: Number(result.cycleId),
    resetCount: Number(result.resetCount),
    votesPerUser: Number(result.votesPerUser),
    selectionCount: Number(result.selectionCount),
    refundedVoteCount: Number(result.refundedVoteCount),
    affectedVoterCount: Number(result.affectedVoterCount),
    submissionRefunds,
    replayed: result.replayed,
  });
}

export async function refundDisqualifiedVotes(params: {
  actorDiscordUserId: string;
  cycleId: number;
  expectedResetCount: number;
  expectedVotesPerUser: number;
  selections: readonly VoteRefundSelection[];
  reasonText: string | null;
  idempotencyKey: string;
}): Promise<VoteRefundResult> {
  assertServerMutationAllowed();
  let response;

  try {
    response = await supabaseAdmin.rpc("refund_disqualified_votes", {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_cycle_id: params.cycleId,
      p_expected_reset_count: params.expectedResetCount,
      p_expected_votes_per_user: params.expectedVotesPerUser,
      p_selections: params.selections,
      p_reason_text: params.reasonText,
      p_idempotency_key: params.idempotencyKey,
    });
  } catch {
    throw refundUnavailable();
  }

  if (response.error) throw mapRpcError(response.error);
  const result = parseResult(response.data);
  if (!result) throw refundUnavailable();
  return result;
}
