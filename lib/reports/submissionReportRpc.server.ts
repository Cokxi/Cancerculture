import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getSubmissionReportReporterDedupeKey,
  SubmissionReportIdentityConfigurationError,
} from "@/lib/reports/submissionReportIdentity.server";
import {
  SUBMISSION_REPORT_TAXONOMY_VERSION,
  type SubmissionReportCreateInput,
} from "@/lib/reports/submissionReportContract";

type RpcError = Readonly<{
  code?: string | null;
  message?: string | null;
}>;

export class SubmissionReportError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "SubmissionReportError";
    this.status = status;
    this.code = code;
  }
}

function rpcError(error: RpcError): SubmissionReportError {
  const message = error.message ?? "";

  if (message.includes("SUBMISSION_REPORT_ALREADY_REPORTED")) {
    return new SubmissionReportError(409, "ALREADY_REPORTED");
  }
  if (message.includes("SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT")) {
    return new SubmissionReportError(409, "IDEMPOTENCY_CONFLICT");
  }
  if (message.includes("SUBMISSION_REPORT_NOT_REPORTABLE")) {
    return new SubmissionReportError(404, "SUBMISSION_NOT_REPORTABLE");
  }
  if (message.includes("SUBMISSION_REPORT_INVALID")) {
    return new SubmissionReportError(400, "INVALID_REPORT");
  }
  if (error.code === "PT409") {
    return new SubmissionReportError(409, "REPORT_CONFLICT");
  }

  return new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
}

function identity(discordUserId: string) {
  try {
    return getSubmissionReportReporterDedupeKey(discordUserId);
  } catch (error) {
    if (error instanceof SubmissionReportIdentityConfigurationError) {
      throw new SubmissionReportError(
        503,
        "REPORT_CONFIGURATION_UNAVAILABLE"
      );
    }
    throw error;
  }
}

export async function getSubmissionReportEligibility({
  discordUserId,
  submissionId,
}: {
  discordUserId: string;
  submissionId: number;
}) {
  const reporterIdentity = identity(discordUserId);
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_report_eligibility",
    {
      p_reporter_discord_user_id: discordUserId,
      p_reporter_dedupe_version: reporterIdentity.version,
      p_reporter_dedupe_hash: reporterIdentity.digest,
      p_submission_id: submissionId,
    }
  );

  if (error) throw rpcError(error);
  if (!data || typeof data !== "object") {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  const result = data as Record<string, unknown>;
  return Object.freeze({
    canReport: result.canReport === true,
    alreadyReported: result.alreadyReported === true,
    hasMultipleExistingReports:
      result.hasMultipleExistingReports === true,
  });
}

export async function createSubmissionReport({
  discordUserId,
  input,
}: {
  discordUserId: string;
  input: SubmissionReportCreateInput;
}) {
  const reporterIdentity = identity(discordUserId);
  const { data, error } = await supabaseAdmin.rpc(
    "create_submission_report_v2",
    {
      p_reporter_discord_user_id: discordUserId,
      p_reporter_dedupe_version: reporterIdentity.version,
      p_reporter_dedupe_hash: reporterIdentity.digest,
      p_submission_id: input.submissionId,
      p_reason_taxonomy_version: SUBMISSION_REPORT_TAXONOMY_VERSION,
      p_reason_code: input.reason,
      p_subcategory_code: input.subcategory,
      p_comment: input.comment,
      p_idempotency_key: input.idempotencyKey,
    }
  );

  if (error) throw rpcError(error);
  if (!data || typeof data !== "object") {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  const result = data as Record<string, unknown>;
  if (
    typeof result.reportId !== "string" ||
    typeof result.caseId !== "string" ||
    typeof result.createdAt !== "string"
  ) {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  return Object.freeze({
    reportId: result.reportId,
    caseId: result.caseId,
    createdAt: result.createdAt,
    replayed: result.replayed === true,
  });
}

export function submissionReportErrorResponse(error: unknown) {
  if (error instanceof SubmissionReportError) {
    return { status: error.status, code: error.code } as const;
  }
  if (error instanceof AuthError) {
    return { status: error.status, code: error.code } as const;
  }
  return { status: 500, code: "REPORT_FAILED" } as const;
}
