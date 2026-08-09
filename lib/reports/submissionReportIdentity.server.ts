import "server-only";

import { createHmac } from "node:crypto";

const DEDUPE_KEY_VERSION = 1;
const TEST_SECRET = "cancerculture-submission-report-test-secret-only";

export class SubmissionReportIdentityConfigurationError extends Error {
  constructor() {
    super("Submission report identity configuration unavailable");
    this.name = "SubmissionReportIdentityConfigurationError";
  }
}

function getSecret() {
  if (process.env.NODE_ENV !== "production") {
    return process.env.SUBMISSION_REPORT_IDENTITY_HMAC_SECRET?.trim() ||
      TEST_SECRET;
  }

  const secret =
    process.env.SUBMISSION_REPORT_IDENTITY_HMAC_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new SubmissionReportIdentityConfigurationError();
  }

  return secret;
}

export function getSubmissionReportReporterDedupeKey(
  discordUserId: string
) {
  const normalizedUserId = discordUserId.trim();
  if (!normalizedUserId || normalizedUserId.length > 100) {
    throw new SubmissionReportIdentityConfigurationError();
  }

  return {
    version: DEDUPE_KEY_VERSION,
    digest: createHmac("sha256", getSecret())
      .update(`submission-report:${normalizedUserId}`, "utf8")
      .digest("hex"),
  } as const;
}
