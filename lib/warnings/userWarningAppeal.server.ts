import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type OwnUserWarningAppealStatus = Readonly<{
  appealable: boolean;
  status: "submitted" | "upheld" | "withdrawn" | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}>;

export class UserWarningAppealConflict extends Error {
  constructor(readonly reason: "already_submitted" | "withdrawn" | "stale" | "idempotency") {
    super("Warning Appeal state changed");
    this.name = "UserWarningAppealConflict";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unavailable() {
  return new AuthError(503, "Warning Appeal temporarily unavailable", "USER_WARNING_APPEAL_UNAVAILABLE");
}

function timestampOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

export async function loadOwnUserWarningAppealStatus(input: {
  sessionId: string;
  publicWarningId: string;
}): Promise<OwnUserWarningAppealStatus | null> {
  if (!UUID_PATTERN.test(input.publicWarningId)) return null;
  const { data, error } = await supabaseAdmin.rpc("get_own_user_warning_appeal_status", {
    p_session_id: input.sessionId,
    p_public_warning_id: input.publicWarningId,
  });
  if (error) {
    console.error("[USER_WARNING_APPEAL] Status RPC failed", { code: error.code });
    throw unavailable();
  }
  const result = record(data);
  if (result.outcome === "not_found") return null;
  if (
    result.outcome !== "found" || result.warningId !== input.publicWarningId ||
    typeof result.appealable !== "boolean" ||
    ![null, "submitted", "upheld", "withdrawn"].includes(result.status as null | string) ||
    !timestampOrNull(result.submittedAt) || !timestampOrNull(result.reviewedAt) ||
    (result.appealable && result.status !== null) ||
    (!result.appealable && result.status === null && result.submittedAt !== null) ||
    (result.status === "submitted" && result.reviewedAt !== null) ||
    ((result.status === "upheld" || result.status === "withdrawn") && result.reviewedAt === null)
  ) throw unavailable();
  return Object.freeze({
    appealable: result.appealable,
    status: result.status as OwnUserWarningAppealStatus["status"],
    submittedAt: result.submittedAt as string | null,
    reviewedAt: result.reviewedAt as string | null,
  });
}

export async function submitOwnUserWarningAppeal(input: {
  sessionId: string;
  publicWarningId: string;
  appealText: string;
  requestId: string;
}) {
  const appealText = input.appealText.trim().normalize("NFC");
  if (
    !UUID_PATTERN.test(input.publicWarningId) || !UUID_PATTERN.test(input.requestId) ||
    appealText.length < 20 || appealText.length > 1000 || /[\u0000\r]/u.test(appealText)
  ) throw new AuthError(400, "Invalid Warning Appeal", "USER_WARNING_APPEAL_INVALID");
  const { data, error } = await supabaseAdmin.rpc("submit_user_warning_appeal", {
    p_session_id: input.sessionId,
    p_public_warning_id: input.publicWarningId,
    p_appeal_text: appealText,
    p_request_id: input.requestId,
  });
  if (error) {
    console.error("[USER_WARNING_APPEAL] Submit RPC failed", { code: error.code });
    if (error.code === "PT409") {
      if (error.message.includes("ALREADY_SUBMITTED")) throw new UserWarningAppealConflict("already_submitted");
      if (error.message.includes("WARNING_WITHDRAWN")) throw new UserWarningAppealConflict("withdrawn");
      throw new UserWarningAppealConflict("idempotency");
    }
    if (error.code === "P0002") throw new AuthError(404, "Warning not found", "USER_WARNING_NOT_FOUND");
    throw unavailable();
  }
  const result = record(data);
  if (
    result.outcome !== "submitted" || result.warningId !== input.publicWarningId ||
    result.status !== "submitted" || typeof result.replayed !== "boolean"
  ) throw unavailable();
  return result;
}

export async function loadTeamUserWarningAppealCaseDetail(actorDiscordUserId: string, caseId: string) {
  if (!UUID_PATTERN.test(caseId)) throw new AuthError(400, "Invalid case", "TEAM_INBOX_CASE_INVALID");
  const { data, error } = await supabaseAdmin.rpc("get_user_warning_appeal_case_detail", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_case_id: caseId,
  });
  if (error) {
    console.error("[USER_WARNING_APPEAL] Detail RPC failed", { code: error.code });
    if (error.code === "42501") throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
    throw unavailable();
  }
  return record(data);
}

export async function reviewTeamUserWarningAppeal(input: {
  caseId: string;
  outcome: "uphold" | "overrule";
  expectedCaseRowVersion: number;
  expectedCaseWorkVersion: number;
  expectedCaseSourceVersion: number;
  expectedAppealRowVersion: number;
  expectedWarningRowVersion: number;
  reason: string;
  requestId: string;
}) {
  const reason = input.reason.trim().normalize("NFC");
  const versions = [
    input.expectedCaseRowVersion, input.expectedCaseWorkVersion,
    input.expectedCaseSourceVersion, input.expectedAppealRowVersion,
    input.expectedWarningRowVersion,
  ];
  if (
    !UUID_PATTERN.test(input.caseId) || !UUID_PATTERN.test(input.requestId) ||
    !versions.every((value) => Number.isSafeInteger(value) && value > 0) ||
    reason.length < 3 || reason.length > 1000 || /[\u0000\r]/u.test(reason)
  ) throw new AuthError(400, "Invalid Warning Appeal review", "USER_WARNING_APPEAL_REVIEW_INVALID");
  const authorization = await requireDynamicTeamCapability("users.warning_appeals.review");
  const { data, error } = await supabaseAdmin.rpc("review_user_warning_appeal", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_case_id: input.caseId,
    p_outcome: input.outcome,
    p_expected_case_row_version: input.expectedCaseRowVersion,
    p_expected_case_work_version: input.expectedCaseWorkVersion,
    p_expected_case_source_version: input.expectedCaseSourceVersion,
    p_expected_appeal_row_version: input.expectedAppealRowVersion,
    p_expected_warning_row_version: input.expectedWarningRowVersion,
    p_reason: reason,
    p_request_id: input.requestId,
  });
  if (error) {
    console.error("[USER_WARNING_APPEAL] Review RPC failed", { code: error.code });
    if (error.code === "42501") throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
    if (error.code === "PT409") throw new UserWarningAppealConflict(
      error.message.includes("IDEMPOTENCY") ? "idempotency" : "stale"
    );
    throw unavailable();
  }
  const result = record(data);
  if (result.outcome === "stale") throw new UserWarningAppealConflict("stale");
  if (result.outcome !== "upheld" && result.outcome !== "overruled") throw unavailable();
  return result;
}
