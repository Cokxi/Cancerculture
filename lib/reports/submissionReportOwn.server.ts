import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import {
  getSubmissionReportReporterDedupeKey,
  SubmissionReportIdentityConfigurationError,
} from "@/lib/reports/submissionReportIdentity.server";
import {
  encodeSubmissionReportCursor,
  parseSubmissionReportCursor,
} from "@/lib/reports/submissionReportCursor";
import { SubmissionReportError } from "@/lib/reports/submissionReportRpc.server";

type JsonObject = Record<string, unknown>;
const PAGE_SIZE = 25;

export async function loadOwnSubmissionReports({
  cursor: cursorValue,
  discordUserId,
}: {
  cursor?: string | null;
  discordUserId: string;
}) {
  const cursor = parseSubmissionReportCursor(cursorValue);
  if (cursorValue && !cursor) {
    throw new SubmissionReportError(400, "REPORT_CURSOR_INVALID");
  }
  let identity: ReturnType<typeof getSubmissionReportReporterDedupeKey>;
  try {
    identity = getSubmissionReportReporterDedupeKey(discordUserId);
  } catch (error) {
    if (error instanceof SubmissionReportIdentityConfigurationError) {
      throw new SubmissionReportError(
        503,
        "REPORT_CONFIGURATION_UNAVAILABLE"
      );
    }
    throw error;
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_own_submission_reports",
    {
      p_reporter_discord_user_id: discordUserId,
      p_reporter_dedupe_version: identity.version,
      p_reporter_dedupe_hash: identity.digest,
      p_before_created_at: cursor?.createdAt ?? null,
      p_before_report_id: cursor?.reportId ?? null,
      p_limit: PAGE_SIZE,
    }
  );

  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  const reports = (data as JsonObject).reports;
  const nextCursor = (data as JsonObject).nextCursor;
  if (
    !Array.isArray(reports) ||
    (nextCursor !== null &&
      (!nextCursor ||
        typeof nextCursor !== "object" ||
        Array.isArray(nextCursor)))
  ) {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  const items = reports.filter(
      (report): report is JsonObject =>
        Boolean(report) && typeof report === "object" && !Array.isArray(report)
    );
  if (items.length !== reports.length) {
    throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
  }

  let encodedNextCursor: string | null = null;
  if (nextCursor) {
    const raw = nextCursor as JsonObject;
    if (
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      typeof raw.reportId !== "string"
    ) {
      throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
    }
    const encoded = encodeSubmissionReportCursor({
      createdAt: raw.createdAt,
      reportId: raw.reportId,
    });
    if (!parseSubmissionReportCursor(encoded)) {
      throw new SubmissionReportError(503, "REPORT_SERVICE_UNAVAILABLE");
    }
    encodedNextCursor = encoded;
  }

  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: encodedNextCursor,
  });
}
