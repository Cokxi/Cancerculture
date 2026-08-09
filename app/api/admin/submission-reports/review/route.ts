export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import {
  reviewSubmissionReportCase,
  type SubmissionReportReviewInput,
} from "@/lib/reports/submissionReportTeam.server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATIONS = new Set(["acknowledge", "start_review", "return_open", "close"]);
const STATUSES = new Set(["open", "in_review", "closed"]);
const DISPOSITIONS = new Set([
  "action_taken",
  "no_action_current_rules",
  "insufficient_information",
  "submission_unavailable",
  "completed_other",
]);

function parse(value: unknown): SubmissionReportReviewInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const note = typeof input.note === "string" && input.note.trim()
    ? input.note.trim()
    : null;
  const disposition = typeof input.disposition === "string"
    ? input.disposition
    : null;
  if (
    typeof input.caseId !== "string" || !UUID_PATTERN.test(input.caseId) ||
    typeof input.operation !== "string" || !OPERATIONS.has(input.operation) ||
    typeof input.expectedStatus !== "string" || !STATUSES.has(input.expectedStatus) ||
    typeof input.expectedRowVersion !== "number" ||
    !Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 1 ||
    typeof input.expectedLatestReportId !== "string" || !UUID_PATTERN.test(input.expectedLatestReportId) ||
    typeof input.idempotencyKey !== "string" || !UUID_PATTERN.test(input.idempotencyKey) ||
    (input.operation === "close" && (!disposition || !DISPOSITIONS.has(disposition))) ||
    (input.operation !== "close" && disposition !== null) ||
    ((input.operation === "return_open" || input.operation === "close") &&
      (!note || note.length < 10 || note.length > 1000))
  ) return null;

  return {
    caseId: input.caseId,
    operation: input.operation as SubmissionReportReviewInput["operation"],
    expectedStatus: input.expectedStatus as SubmissionReportReviewInput["expectedStatus"],
    expectedRowVersion: input.expectedRowVersion,
    expectedLatestReportId: input.expectedLatestReportId,
    disposition,
    note,
    idempotencyKey: input.idempotencyKey,
  };
}

export async function POST(request: Request) {
  try {
    const input = parse(await request.json().catch(() => null));
    if (!input) {
      return NextResponse.json({ error: "INVALID_REVIEW" }, { status: 400 });
    }
    return NextResponse.json(await reviewSubmissionReportCase(input));
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 500;
    return NextResponse.json(
      { error: getAuthErrorCode(error) ?? "REVIEW_FAILED" },
      { status }
    );
  }
}
