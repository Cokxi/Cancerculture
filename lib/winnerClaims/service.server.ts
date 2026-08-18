import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { TwoFactorSession } from "@/lib/twoFactor/service.server";

export const WINNER_CLAIM_STATUSES = [
  "not_required",
  "unclaimed",
  "correction_pending",
  "confirmed",
  "declined",
  "expired",
] as const;

export type WinnerClaimStatus = (typeof WINNER_CLAIM_STATUSES)[number];
export type WinnerRecipientSource = "profile" | "correction" | "submission";
export type WinnerPayoutChoice = "keep" | "split" | "donate";

export class WinnerClaimError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "WinnerClaimError";
    this.status = status;
    this.code = code;
  }
}

type RpcObject = Record<string, unknown>;

function objectValue(value: unknown): RpcObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RpcObject)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function finiteNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payoutChoice(value: unknown): WinnerPayoutChoice | null {
  return value === "keep" || value === "split" || value === "donate"
    ? value
    : null;
}

function claimStatus(value: unknown): WinnerClaimStatus | null {
  return WINNER_CLAIM_STATUSES.includes(value as WinnerClaimStatus)
    ? (value as WinnerClaimStatus)
    : null;
}

function recipientSource(value: unknown): WinnerRecipientSource | null {
  return value === "profile" || value === "correction" || value === "submission"
    ? value
    : null;
}

function rpcError(error: { message: string }): never {
  const code =
    error.message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ??
    "WINNER_CLAIM_UNAVAILABLE";
  const status =
    code.includes("FORBIDDEN") ? 403 :
    code.includes("INPUT_INVALID") || code.includes("CONFIRMATION_REQUIRED") ? 400 :
    code.includes("REQUEST_REUSED") || code.includes("PROFILE_WALLET_OWNER_CONTROLLED") ? 409 :
    code.includes("SESSION_INVALID") ? 401 : 503;
  throw new WinnerClaimError(status, code);
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) rpcError(error);
  return objectValue(data);
}

function requireOutcome(result: RpcObject, expected: string) {
  if (result.outcome !== expected) {
    throw new WinnerClaimError(
      result.outcome === "not_found" ? 404 : 503,
      result.outcome === "not_found"
        ? "WINNER_CLAIM_NOT_FOUND"
        : "WINNER_CLAIM_UNAVAILABLE"
    );
  }
}

export type OwnWinnerClaimSummary = {
  claimId: string;
  cycleId: number;
  cycleNumber: number | null;
  submissionId: number;
  payoutChoice: WinnerPayoutChoice;
  splitPercent: number | null;
  charity: string | null;
  status: WinnerClaimStatus;
  finalizedAt: string;
  deadlineAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
};

function parseSummary(value: unknown): OwnWinnerClaimSummary | null {
  const row = objectValue(value);
  const choice = payoutChoice(row.payoutChoice);
  const status = claimStatus(row.status);
  const claimId = stringValue(row.claimId);
  const cycleId = numberValue(row.cycleId);
  const submissionId = numberValue(row.submissionId);
  const finalizedAt = stringValue(row.finalizedAt);
  if (!choice || !status || !claimId || cycleId === null || submissionId === null || !finalizedAt) {
    return null;
  }
  return {
    claimId,
    cycleId,
    cycleNumber: numberValue(row.cycleNumber),
    submissionId,
    payoutChoice: choice,
    splitPercent: numberValue(row.splitPercent),
    charity: stringValue(row.charity),
    status,
    finalizedAt,
    deadlineAt: stringValue(row.deadlineAt),
    confirmedAt: stringValue(row.confirmedAt),
    declinedAt: stringValue(row.declinedAt),
    expiredAt: stringValue(row.expiredAt),
  };
}

export async function getOwnWinnerClaims(session: TwoFactorSession) {
  const result = await rpc("get_own_winner_claims", {
    p_session_id: session.session_id,
  });
  requireOutcome(result, "ok");
  const rawItems = Array.isArray(result.items) ? result.items : [];
  const items = rawItems.map(parseSummary);
  if (items.some((item) => item === null)) {
    throw new WinnerClaimError(503, "WINNER_CLAIM_UNAVAILABLE");
  }
  return {
    databaseTime: stringValue(result.databaseTime),
    items: items as OwnWinnerClaimSummary[],
  };
}

export type OwnWinnerClaim = OwnWinnerClaimSummary & {
  claimVersion: number;
  initialDeadlineAt: string | null;
  confirmedRecipient: string | null;
  confirmedRecipientSource: WinnerRecipientSource | null;
  candidate: null | {
    address: string;
    source: WinnerRecipientSource;
    sourceVersion: number | null;
    revision: string;
  };
};

export async function getOwnWinnerClaim(
  session: TwoFactorSession,
  claimId: string
): Promise<{ databaseTime: string | null; claim: OwnWinnerClaim }> {
  const result = await rpc("get_own_winner_claim", {
    p_session_id: session.session_id,
    p_claim_id: claimId,
  });
  requireOutcome(result, "ok");
  const summary = parseSummary(result);
  const claimVersion = numberValue(result.claimVersion);
  if (!summary || claimVersion === null) {
    throw new WinnerClaimError(503, "WINNER_CLAIM_UNAVAILABLE");
  }
  const candidateResult = objectValue(result.candidate);
  let candidate: OwnWinnerClaim["candidate"] = null;
  if (candidateResult.outcome === "ready") {
    const address = stringValue(candidateResult.address);
    const source = recipientSource(candidateResult.source);
    const revision = stringValue(candidateResult.revision);
    if (!address || !source || !revision) {
      throw new WinnerClaimError(503, "WINNER_CLAIM_UNAVAILABLE");
    }
    candidate = {
      address,
      source,
      sourceVersion: numberValue(candidateResult.sourceVersion),
      revision,
    };
  }
  return {
    databaseTime: stringValue(result.databaseTime),
    claim: {
      ...summary,
      claimVersion,
      initialDeadlineAt: stringValue(result.initialDeadlineAt),
      confirmedRecipient: stringValue(result.confirmedRecipient),
      confirmedRecipientSource: recipientSource(result.confirmedRecipientSource),
      candidate,
    },
  };
}

export type WinnerClaimAction = "confirm" | "decline";

export async function mutateOwnWinnerClaim({
  session,
  claimId,
  requestId,
  action,
  expectedCandidateRevision,
  acknowledged,
}: {
  session: TwoFactorSession;
  claimId: string;
  requestId: string;
  action: WinnerClaimAction;
  expectedCandidateRevision: string | null;
  acknowledged: boolean;
}) {
  return rpc("mutate_own_winner_claim", {
    p_session_id: session.session_id,
    p_claim_id: claimId,
    p_request_id: requestId,
    p_action: action,
    p_expected_candidate_revision: expectedCandidateRevision,
    p_publication_acknowledged: acknowledged,
  });
}

export type TeamWinnerClaim = {
  claimId: string;
  claimVersion: number;
  cycleId: number;
  cycleNumber: number | null;
  cycleTheme: string | null;
  submissionId: number;
  discordUserId: string;
  publicProfileId: string | null;
  currentDiscordUsername: string | null;
  currentDiscordHandle: string | null;
  currentDisplayName: string | null;
  currentGuildNickname: string | null;
  voteCount: number;
  winShare: number;
  payoutChoice: WinnerPayoutChoice;
  splitPercent: number | null;
  charity: string | null;
  status: WinnerClaimStatus;
  finalizedAt: string;
  deadlineAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  confirmedRecipientSource: WinnerRecipientSource | null;
  walletAddress: string | null;
  profileWalletOwnerControlled: boolean;
  correctionEligible: boolean;
  latestCorrection: null | {
    version: number;
    status: "pending" | "ready" | "incorrect" | "superseded";
    proposedRecipient: string | null;
  };
};

function parseTeamWinner(value: unknown): TeamWinnerClaim | null {
  const row = objectValue(value);
  const summary = parseSummary(row);
  const claimVersion = numberValue(row.claimVersion);
  const discordUserId = stringValue(row.discordUserId);
  const voteCount = numberValue(row.voteCount);
  const winShare = finiteNumberValue(row.winShare);
  if (!summary || claimVersion === null || !discordUserId || voteCount === null || winShare === null) {
    return null;
  }
  const rawCorrection = objectValue(row.latestCorrection);
  const correctionStatus = rawCorrection.status;
  const latestCorrection: TeamWinnerClaim["latestCorrection"] =
    typeof rawCorrection.version === "number" &&
    (correctionStatus === "pending" || correctionStatus === "ready" ||
      correctionStatus === "incorrect" || correctionStatus === "superseded")
      ? {
          version: rawCorrection.version,
          status: correctionStatus,
          proposedRecipient: stringValue(rawCorrection.proposedRecipient),
        }
      : null;

  return {
    ...summary,
    claimVersion,
    cycleTheme: stringValue(row.cycleTheme),
    discordUserId,
    publicProfileId: stringValue(row.publicProfileId),
    currentDiscordUsername: stringValue(row.currentDiscordUsername),
    currentDiscordHandle: stringValue(row.currentDiscordHandle),
    currentDisplayName: stringValue(row.currentDisplayName),
    currentGuildNickname: stringValue(row.currentGuildNickname),
    voteCount,
    winShare,
    confirmedRecipientSource: recipientSource(row.confirmedRecipientSource),
    walletAddress: stringValue(row.walletAddress),
    profileWalletOwnerControlled: row.profileWalletOwnerControlled === true,
    correctionEligible: row.correctionEligible === true,
    latestCorrection,
  };
}

export async function getTeamWinnerClaims({
  actorDiscordUserId,
  includeCorrections,
}: {
  actorDiscordUserId: string;
  includeCorrections: boolean;
}) {
  const result = await rpc("get_team_winner_claims", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_include_corrections: includeCorrections,
  });
  requireOutcome(result, "ok");
  const rawItems = Array.isArray(result.items) ? result.items : [];
  const items = rawItems.map(parseTeamWinner);
  if (items.some((item) => item === null)) {
    throw new WinnerClaimError(503, "WINNER_CLAIM_UNAVAILABLE");
  }
  return {
    databaseTime: stringValue(result.databaseTime),
    items: items as TeamWinnerClaim[],
  };
}

export async function manageWinnerRecipientCorrection({
  actorDiscordUserId,
  requestId,
  claimId,
  expectedClaimVersion,
  proposedRecipient,
}: {
  actorDiscordUserId: string;
  requestId: string;
  claimId: string;
  expectedClaimVersion: number;
  proposedRecipient: string;
}) {
  return rpc("manage_winner_recipient_correction", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_request_id: requestId,
    p_claim_id: claimId,
    p_expected_claim_version: expectedClaimVersion,
    p_proposed_recipient: proposedRecipient,
  });
}
