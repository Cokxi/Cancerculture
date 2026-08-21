import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { TwoFactorSession } from "@/lib/twoFactor/service.server";

export class PayoutError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "PayoutError";
    this.status = status;
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function payoutRpcError(error: { message: string }): never {
  const code = error.message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ?? "PAYOUT_UNAVAILABLE";
  const status = code.includes("FORBIDDEN") ? 403 : code.includes("INVALID") ? 400 : code.includes("REUSED") ? 409 : 503;
  throw new PayoutError(status, code);
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) payoutRpcError(error);
  return objectValue(data);
}

function requireOk(result: JsonObject, allowed = ["ok"]) {
  if (!allowed.includes(String(result.outcome))) {
    const outcome = String(result.outcome ?? "unavailable");
    throw new PayoutError(outcome === "not_found" ? 404 : outcome === "stale" || outcome === "state_conflict" ? 409 : 503, `PAYOUT_${outcome.toUpperCase()}`);
  }
  return result;
}

export async function getCurrentCyclePrizePool() {
  const { data, error } = await supabaseAdmin.rpc("get_current_cycle_prize_pool");
  if (error) payoutRpcError(error);
  const row = objectValue(data);
  return {
    cycleId: typeof row.cycleId === "number" ? row.cycleId : null,
    cycleNumber: typeof row.cycleNumber === "number" ? row.cycleNumber : null,
    totalLamports: typeof row.totalLamports === "string" && /^[0-9]+$/.test(row.totalLamports) ? row.totalLamports : null,
  };
}

export async function getTeamPayoutContext(actorDiscordUserId: string, includeManagement: boolean) {
  const result = requireOk(await rpc("get_team_payout_context", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_include_management: includeManagement,
  }));
  return {
    databaseTime: typeof result.databaseTime === "string" ? result.databaseTime : null,
    pools: Array.isArray(result.pools) ? result.pools : [],
    allocations: Array.isArray(result.allocations) ? result.allocations : [],
    plans: Array.isArray(result.plans) ? result.plans : [],
  };
}

export async function getTeamPayoutLogs(actorDiscordUserId: string, limit = 200) {
  const result = requireOk(await rpc("get_team_payout_logs", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_limit: limit,
  }));
  return Array.isArray(result.items) ? result.items : [];
}

export async function preparePayoutPlan(actorDiscordUserId: string, input: { requestId: string; allocationPublicId: string; expectedClaimVersion: number }) {
  return requireOk(await rpc("prepare_payout_plan", {
    p_actor_discord_user_id: actorDiscordUserId, p_request_id: input.requestId,
    p_allocation_public_id: input.allocationPublicId, p_expected_claim_version: input.expectedClaimVersion,
  }), ["prepared", "already_prepared"]);
}

export async function managePayoutPlan(actorDiscordUserId: string, input: {
  requestId: string; planPublicId: string; expectedPlanVersion: number; operation: string; payload: JsonObject;
}) {
  return requireOk(await rpc("manage_payout_plan", {
    p_actor_discord_user_id: actorDiscordUserId, p_request_id: input.requestId,
    p_plan_public_id: input.planPublicId, p_expected_plan_version: input.expectedPlanVersion,
    p_operation: input.operation, p_payload: input.payload,
  }));
}

export async function recordPayoutTransaction(actorDiscordUserId: string, input: {
  requestId: string; linePublicId: string; expectedLineVersion: number; signature: string;
  evidenceLevel: "on_chain_verified" | "operator_confirmed_provider"; providerReference: string | null;
  verificationSlot: number | null; verifiedMainnet: boolean; verifiedSuccess: boolean;
  verifiedRecipient: string | null; verifiedLamports: bigint | null; replacesTransactionPublicId?: string | null;
}) {
  return requireOk(await rpc("record_payout_transaction", {
    p_actor_discord_user_id: actorDiscordUserId, p_request_id: input.requestId,
    p_line_public_id: input.linePublicId, p_expected_line_version: input.expectedLineVersion,
    p_signature: input.signature, p_evidence_level: input.evidenceLevel,
    p_provider_reference: input.providerReference, p_verification_slot: input.verificationSlot,
    p_verified_mainnet: input.verifiedMainnet, p_verified_success: input.verifiedSuccess,
    p_verified_recipient: input.verifiedRecipient,
    p_verified_lamports: input.verifiedLamports?.toString() ?? null,
    p_replaces_transaction_public_id: input.replacesTransactionPublicId ?? null,
  }), ["verified"]);
}

export type OwnPayoutReturnClaim = {
  claimPublicId: string; rowVersion: number; cycleId: number; cycleNumber: number | null;
  submissionId: number; amountLamports: string; status: string; deadlineAt: string | null;
};

export async function getOwnPayoutReturnClaims(session: TwoFactorSession) {
  const result = requireOk(await rpc("get_own_payout_return_claims", { p_session_id: session.session_id }));
  const items = (Array.isArray(result.items) ? result.items : []).map((value) => objectValue(value)).map((row) => ({
    claimPublicId: String(row.claimPublicId ?? ""), rowVersion: Number(row.rowVersion), cycleId: Number(row.cycleId),
    cycleNumber: typeof row.cycleNumber === "number" ? row.cycleNumber : null, submissionId: Number(row.submissionId),
    amountLamports: String(row.amountLamports ?? ""), status: String(row.status ?? ""),
    deadlineAt: typeof row.deadlineAt === "string" ? row.deadlineAt : null,
  })).filter((row) => /^[0-9a-f-]{36}$/i.test(row.claimPublicId) && Number.isSafeInteger(row.rowVersion) && /^[0-9]+$/.test(row.amountLamports));
  return { databaseTime: typeof result.databaseTime === "string" ? result.databaseTime : null, items };
}

export async function mutateOwnPayoutReturnClaim(session: TwoFactorSession, input: {
  claimPublicId: string; requestId: string; expectedVersion: number; action: "confirm" | "decline"; manualRecipient: string | null;
}) {
  return rpc("mutate_own_payout_return_claim", {
    p_session_id: session.session_id, p_claim_public_id: input.claimPublicId, p_request_id: input.requestId,
    p_expected_version: input.expectedVersion, p_action: input.action, p_manual_recipient: input.manualRecipient,
  });
}

export async function attachPayoutPrivateEvidence(actorDiscordUserId: string, input: {
  requestId: string; transactionPublicId: string; r2Key: string; byteSize: number; width: number; height: number;
}) {
  return requireOk(await rpc("attach_payout_private_evidence", {
    p_actor_discord_user_id: actorDiscordUserId, p_request_id: input.requestId,
    p_transaction_public_id: input.transactionPublicId, p_r2_key: input.r2Key,
    p_byte_size: input.byteSize, p_width: input.width, p_height: input.height,
  }), ["attached"]);
}

export type SimpleTeamPayoutItem = Record<string, unknown>;

export async function getSimpleTeamPayouts(
  actorDiscordUserId: string,
  includeManagement: boolean
) {
  const result = requireOk(await rpc("get_simple_team_payouts_v2", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_include_management: includeManagement,
  }));
  return {
    databaseTime:
      typeof result.databaseTime === "string" ? result.databaseTime : null,
    items: Array.isArray(result.items)
      ? result.items as SimpleTeamPayoutItem[]
      : [],
  };
}

export async function requestDonationRecipientCorrection(
  actorDiscordUserId: string,
  input: { requestId: string; allocationPublicId: string; publicReason: string }
) {
  return requireOk(await rpc("request_donation_recipient_correction", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_request_id: input.requestId,
    p_allocation_public_id: input.allocationPublicId,
    p_public_reason: input.publicReason,
  }), ["correction_requested"]);
}

export async function disqualifyPayoutAllocation(
  actorDiscordUserId: string,
  input: { requestId: string; allocationPublicId: string; publicReason: string }
) {
  return requireOk(await rpc("disqualify_payout_allocation", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_request_id: input.requestId,
    p_allocation_public_id: input.allocationPublicId,
    p_public_reason: input.publicReason,
  }), ["disqualified", "already_disqualified"]);
}

export async function completeAndPublishPayout(
  actorDiscordUserId: string,
  input: {
    requestId: string;
    allocationPublicId: string;
    expectedClaimVersion: number;
    donationOperationRecipient: string | null;
    winnerTransactions: ReadonlyArray<{ signature: string; slot: number; recipient: string; lamports: string }>;
    winnerOverpaymentConfirmed: boolean;
    winnerOverpaymentReason: string | null;
    donationTransactions: ReadonlyArray<{ signature: string; slot: number; recipient: string; lamports: string }>;
    donationOverpaymentConfirmed: boolean;
    donationOverpaymentReason: string | null;
    receiptR2Key: string | null;
    receiptByteSize: number | null;
    receiptWidth: number | null;
    receiptHeight: number | null;
    receiptPublicApproved: boolean;
  }
) {
  return requireOk(await rpc("complete_and_publish_payout_v2", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_request_id: input.requestId,
    p_allocation_public_id: input.allocationPublicId,
    p_expected_claim_version: input.expectedClaimVersion,
    p_donation_operation_recipient: input.donationOperationRecipient,
    p_winner_transactions: input.winnerTransactions,
    p_winner_overpayment_confirmed: input.winnerOverpaymentConfirmed,
    p_winner_overpayment_reason: input.winnerOverpaymentReason,
    p_donation_transactions: input.donationTransactions,
    p_donation_overpayment_confirmed: input.donationOverpaymentConfirmed,
    p_donation_overpayment_reason: input.donationOverpaymentReason,
    p_receipt_r2_key: input.receiptR2Key,
    p_receipt_byte_size: input.receiptByteSize,
    p_receipt_width: input.receiptWidth,
    p_receipt_height: input.receiptHeight,
    p_receipt_public_approved: input.receiptPublicApproved,
  }), ["published"]);
}

export type OwnDonationCorrection = {
  correctionPublicId: string;
  rowVersion: number;
  attemptVersion: number;
  status: string;
  publicReason: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  cycleNumber: number | null;
  submissionId: number;
  payoutChoice: string;
  splitPercent: number | null;
  donationLamports: string;
  currentOrganizationName: string;
};

export async function getOwnPayoutDonationCorrections(session: TwoFactorSession) {
  const result = requireOk(await rpc("get_own_payout_donation_corrections", {
    p_session_id: session.session_id,
  }));
  const items = (Array.isArray(result.items) ? result.items : [])
    .map(objectValue)
    .map((row) => ({
      correctionPublicId: String(row.correctionPublicId ?? ""),
      rowVersion: Number(row.rowVersion),
      attemptVersion: Number(row.attemptVersion),
      status: String(row.status ?? ""),
      publicReason: String(row.publicReason ?? ""),
      deadlineAt: typeof row.deadlineAt === "string" ? row.deadlineAt : null,
      submittedAt: typeof row.submittedAt === "string" ? row.submittedAt : null,
      cycleNumber: typeof row.cycleNumber === "number" ? row.cycleNumber : null,
      submissionId: Number(row.submissionId),
      payoutChoice: String(row.payoutChoice ?? ""),
      splitPercent: typeof row.splitPercent === "number" ? row.splitPercent : null,
      donationLamports: String(row.donationLamports ?? ""),
      currentOrganizationName: String(row.currentOrganizationName ?? ""),
    }))
    .filter((row) =>
      /^[0-9a-f-]{36}$/iu.test(row.correctionPublicId) &&
      Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0 &&
      Number.isSafeInteger(row.submissionId) && row.submissionId > 0 &&
      /^[0-9]+$/u.test(row.donationLamports)
    );
  return {
    databaseTime:
      typeof result.databaseTime === "string" ? result.databaseTime : null,
    items: items as OwnDonationCorrection[],
  };
}

export async function submitOwnPayoutDonationCorrection(
  session: TwoFactorSession,
  input: {
    correctionPublicId: string;
    requestId: string;
    expectedVersion: number;
    sourceType: "catalog" | "other";
    organizationPublicKey: string | null;
    otherName: string | null;
    otherWebsiteUrl: string | null;
  }
) {
  return requireOk(await rpc("submit_own_donation_recipient_correction", {
    p_session_id: session.session_id,
    p_correction_public_id: input.correctionPublicId,
    p_request_id: input.requestId,
    p_expected_version: input.expectedVersion,
    p_source_type: input.sourceType,
    p_organization_public_key: input.organizationPublicKey,
    p_other_name: input.otherName,
    p_other_website_url: input.otherWebsiteUrl,
  }), ["submitted"]);
}

export async function getPublicSubmissionPayout(submissionId: number) {
  const data = await rpc("get_public_submission_payout_v2", {
    p_submission_id: submissionId,
  });
  return Object.keys(data).length > 0 ? data : null;
}

export async function getPublicPayoutReceiptSource(evidencePublicId: string) {
  const data = await rpc("get_public_payout_receipt_source", {
    p_evidence_public_id: evidencePublicId,
  });
  return Object.keys(data).length > 0 ? data : null;
}
