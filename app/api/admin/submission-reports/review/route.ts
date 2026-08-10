export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import {
  manageSubmissionReportCase,
  type SubmissionReportWorkflowInput,
} from "@/lib/reports/submissionReportTeam.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATIONS = new Set([
  "claim",
  "release",
  "forced_release",
  "close",
]);
const STATUSES = new Set(["open", "in_review", "closed"]);
const DISPOSITIONS = new Set([
  "action_taken",
  "no_action_current_rules",
  "insufficient_information",
  "submission_unavailable",
  "completed_other",
]);

function parse(value: unknown): SubmissionReportWorkflowInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const note =
    typeof input.note === "string" && input.note.trim()
      ? input.note.trim()
      : null;
  const disposition =
    typeof input.disposition === "string" ? input.disposition : null;
  const targetDiscordUserId =
    typeof input.targetDiscordUserId === "string"
      ? input.targetDiscordUserId.trim()
      : null;
  const operation = typeof input.operation === "string" ? input.operation : "";
  const noteHasValidLength =
    note === null || (note.length >= 10 && note.length <= 1000);

  if (
    typeof input.caseId !== "string" ||
    !UUID_PATTERN.test(input.caseId) ||
    !OPERATIONS.has(operation) ||
    typeof input.expectedStatus !== "string" ||
    !STATUSES.has(input.expectedStatus) ||
    typeof input.expectedRowVersion !== "number" ||
    !Number.isSafeInteger(input.expectedRowVersion) ||
    input.expectedRowVersion < 1 ||
    typeof input.expectedLatestReportId !== "string" ||
    !UUID_PATTERN.test(input.expectedLatestReportId) ||
    typeof input.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(input.idempotencyKey) ||
    (operation === "close" &&
      (!disposition || !DISPOSITIONS.has(disposition))) ||
    (operation !== "close" && disposition !== null) ||
    targetDiscordUserId !== null ||
    (operation === "forced_release" && note === null) ||
    (["forced_release", "close"].includes(operation) &&
      !noteHasValidLength) ||
    (["claim", "release"].includes(operation) && note !== null)
  ) {
    return null;
  }

  return {
    caseId: input.caseId,
    operation: operation as SubmissionReportWorkflowInput["operation"],
    expectedStatus:
      input.expectedStatus as SubmissionReportWorkflowInput["expectedStatus"],
    expectedRowVersion: input.expectedRowVersion,
    expectedLatestReportId: input.expectedLatestReportId,
    targetDiscordUserId,
    disposition,
    note,
    idempotencyKey: input.idempotencyKey,
  };
}

export async function POST(request: Request) {
  try {
    const input = parse(await request.json().catch(() => null));
    if (!input) {
      return NextResponse.json({ error: "INVALID_WORKFLOW" }, { status: 400 });
    }
    return NextResponse.json(await manageSubmissionReportCase(input));
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 500;
    return NextResponse.json(
      { error: getAuthErrorCode(error) ?? "WORKFLOW_FAILED" },
      { status }
    );
  }
}
