import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(
      503,
      "Submission Report service unavailable",
      "SUBMISSION_REPORT_READ_UNAVAILABLE"
    );
  }
  return value as JsonObject;
}

function asArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new AuthError(
      503,
      "Submission Report service unavailable",
      "SUBMISSION_REPORT_READ_UNAVAILABLE"
    );
  }
  return value.filter(
    (item): item is JsonObject =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function readFailure(error: { code?: string | null; message?: string | null }) {
  const message = error.message ?? "";
  if (message.includes("SUBMISSION_REPORT_CASE_NOT_FOUND") ||
      message.includes("SUBMISSION_REPORT_REPORTER_NOT_FOUND")) {
    return new AuthError(404, "Report record not found", "SUBMISSION_REPORT_NOT_FOUND");
  }
  if (error.code === "42501" || message.includes("SUBMISSION_REPORT_FORBIDDEN")) {
    return new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }
  return new AuthError(
    503,
    "Submission Report service unavailable",
    "SUBMISSION_REPORT_READ_UNAVAILABLE"
  );
}

export async function loadSubmissionReportQueue() {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_submission_report_cases",
    { p_actor_discord_user_id: authorization.discord_user_id, p_limit: 50 }
  );
  if (error) throw readFailure(error);
  return Object.freeze({
    cases: Object.freeze(asArray(data)),
    canReview: hasResolvedTeamCapability(
      authorization,
      "submissions.reports.review"
    ),
  });
}

export async function loadSubmissionReportCase(caseId: string) {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_report_case",
    { p_actor_discord_user_id: authorization.discord_user_id, p_case_id: caseId }
  );
  if (error) throw readFailure(error);
  return Object.freeze({
    case: Object.freeze(asObject(data)),
    canReview: hasResolvedTeamCapability(
      authorization,
      "submissions.reports.review"
    ),
  });
}

export async function loadSubmissionReporterProfiles() {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_submission_reporter_profiles",
    { p_actor_discord_user_id: authorization.discord_user_id, p_limit: 50 }
  );
  if (error) throw readFailure(error);
  return Object.freeze(asArray(data));
}

export async function loadSubmissionReporterHistory(publicProfileId: string) {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.view"
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(publicProfileId)) {
    throw new AuthError(404, "Report record not found", "SUBMISSION_REPORT_NOT_FOUND");
  }
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_reporter_history",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_public_profile_id: publicProfileId,
      p_limit: 100,
    }
  );
  if (error) throw readFailure(error);
  return Object.freeze(asObject(data));
}

export type SubmissionReportReviewInput = Readonly<{
  caseId: string;
  operation: "acknowledge" | "start_review" | "return_open" | "close";
  expectedStatus: "open" | "in_review" | "closed";
  expectedRowVersion: number;
  expectedLatestReportId: string;
  disposition: string | null;
  note: string | null;
  idempotencyKey: string;
}>;

export async function reviewSubmissionReportCase(
  input: SubmissionReportReviewInput
) {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.view"
  );
  if (!hasResolvedTeamCapability(authorization, "submissions.reports.review")) {
    throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }
  const { data, error } = await supabaseAdmin.rpc(
    "review_submission_report_case",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_case_id: input.caseId,
      p_operation: input.operation,
      p_expected_status: input.expectedStatus,
      p_expected_row_version: input.expectedRowVersion,
      p_expected_latest_report_id: input.expectedLatestReportId,
      p_disposition: input.disposition,
      p_note: input.note,
      p_idempotency_key: input.idempotencyKey,
    }
  );
  if (error) {
    if (error.code === "PT409") {
      throw new AuthError(409, "The Report case changed. Refresh and try again.", "SUBMISSION_REPORT_STALE");
    }
    throw readFailure(error);
  }
  return Object.freeze(asObject(data));
}
