import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import type { TeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import type { TwoFactorSession } from "@/lib/twoFactor/service.server";
import {
  isUuid,
  WALLET_ISSUE_DESCRIPTION_MAX_LENGTH,
  WALLET_ISSUE_DESCRIPTION_MIN_LENGTH,
  WALLET_ISSUE_STATUSES,
  type WalletIssueStatus,
} from "@/lib/walletIssues/contract";

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function rpcError(error: { code?: string; message: string }): never {
  const code = error.message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ?? "WALLET_ISSUE_UNAVAILABLE";
  const status = error.code === "42501" || code.includes("FORBIDDEN") ? 403
    : code.includes("INPUT_INVALID") || code.includes("SCREENSHOT_INVALID") ? 400
      : code.includes("CLOSED") || code.includes("COOLDOWN") || code.includes("NOT_APPLICABLE") || code.includes("PROFILE_WALLET_OWNER_CONTROLLED") ? 409
        : 503;
  throw new AuthError(status, "Wallet Issue unavailable", code);
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) rpcError(error);
  return record(data);
}

export type OwnWalletIssueIntake = Readonly<{
  intakeId: string;
  submissionId: number;
  status: WalletIssueStatus;
  submittedAt: string;
}>;

function parseOwn(value: unknown): OwnWalletIssueIntake | null {
  const row = record(value);
  const status = row.status as WalletIssueStatus;
  if (!isUuid(row.intakeId) || !Number.isSafeInteger(row.submissionId) ||
      !WALLET_ISSUE_STATUSES.includes(status) || typeof row.submittedAt !== "string") return null;
  return Object.freeze({
    intakeId: row.intakeId,
    submissionId: row.submissionId as number,
    status,
    submittedAt: row.submittedAt,
  });
}

export async function getOwnWalletIssueIntakes(session: TwoFactorSession) {
  const result = await rpc("get_own_wallet_issue_intakes", { p_session_id: session.session_id });
  const raw = Array.isArray(result.items) ? result.items : [];
  const items = raw.map(parseOwn);
  if (items.some((item) => item === null)) throw new AuthError(503, "Wallet Issue unavailable", "WALLET_ISSUE_INVALID_RESPONSE");
  return items as OwnWalletIssueIntake[];
}

export async function getWalletIssueIntakeReplay(session: TwoFactorSession, requestId: string) {
  if (!isUuid(requestId)) return null;
  const result = await rpc("get_own_wallet_issue_intake_request", {
    p_session_id: session.session_id,
    p_request_id: requestId,
  });
  return result.outcome === "not_found" ? null : result;
}

export async function assertWalletIssueIntakeOpen(session: TwoFactorSession, submissionId: number) {
  return rpc("assert_own_wallet_issue_intake_open", {
    p_session_id: session.session_id,
    p_submission_id: submissionId,
  });
}

export async function createWalletIssueIntake(input: {
  session: TwoFactorSession;
  submissionId: number;
  requestId: string;
  desiredRecipient: string;
  description: string;
  screenshot: { data: Buffer; mime: "image/webp"; sha256: string; size: number } | null;
}) {
  const address = validateSolRecipientAddress(input.desiredRecipient);
  const description = input.description.trim();
  if (!isUuid(input.requestId) || !address.ok ||
      description.length < WALLET_ISSUE_DESCRIPTION_MIN_LENGTH ||
      description.length > WALLET_ISSUE_DESCRIPTION_MAX_LENGTH) {
    throw new AuthError(400, "Invalid Wallet Issue", "WALLET_ISSUE_INTAKE_INPUT_INVALID");
  }
  return rpc("create_own_wallet_issue_intake", {
    p_session_id: input.session.session_id,
    p_submission_id: input.submissionId,
    p_request_id: input.requestId,
    p_desired_recipient: address.address,
    p_description: description,
    p_screenshot_data: input.screenshot ? `\\x${input.screenshot.data.toString("hex")}` : null,
    p_screenshot_mime: input.screenshot?.mime ?? null,
    p_screenshot_sha256: input.screenshot?.sha256 ?? null,
    p_screenshot_size: input.screenshot?.size ?? null,
  });
}

export async function loadWalletIssueMonitor(
  authorization?: TeamAuthorizationContext
) {
  const context = authorization ?? await getTeamAuthorizationContext();
  return rpc("get_team_wallet_issue_intakes", {
    p_actor_discord_user_id: context.discord_user_id,
    p_before_submitted_at: null,
    p_before_id: null,
    p_limit: 50,
  });
}

export async function loadWalletIssueCaseDetail(actorId: string, caseId: string) {
  if (!isUuid(caseId)) throw new AuthError(400, "Invalid case", "WALLET_ISSUE_CASE_INVALID");
  return rpc("get_team_wallet_issue_case_detail", {
    p_actor_discord_user_id: actorId,
    p_case_id: caseId,
  });
}

export async function loadWalletIssueScreenshot(intakeId: string) {
  if (!isUuid(intakeId)) throw new AuthError(400, "Invalid screenshot", "WALLET_ISSUE_SCREENSHOT_INVALID");
  const context = await getTeamAuthorizationContext();
  return rpc("get_team_wallet_issue_screenshot", {
    p_actor_discord_user_id: context.discord_user_id,
    p_intake_id: intakeId,
  });
}

export async function resolveWalletIssueCase(input: {
  caseId: string;
  requestId: string;
  resolution: "accept_correction" | "no_action";
  expectedCaseRowVersion: number;
  expectedCaseWorkVersion: number;
  expectedSourceVersion: number;
  expectedIntakeVersion: number;
  expectedClaimVersion: number;
  note: string | null;
}) {
  if (!isUuid(input.caseId) || !isUuid(input.requestId)) {
    throw new AuthError(400, "Invalid resolution", "WALLET_ISSUE_RESOLUTION_INPUT_INVALID");
  }
  const context = await getTeamAuthorizationContext();
  return rpc("resolve_wallet_issue_case", {
    p_actor_discord_user_id: context.discord_user_id,
    p_case_id: input.caseId,
    p_request_id: input.requestId,
    p_resolution: input.resolution,
    p_expected_case_row_version: input.expectedCaseRowVersion,
    p_expected_case_work_version: input.expectedCaseWorkVersion,
    p_expected_source_version: input.expectedSourceVersion,
    p_expected_intake_version: input.expectedIntakeVersion,
    p_expected_claim_version: input.expectedClaimVersion,
    p_note: input.note,
  });
}
