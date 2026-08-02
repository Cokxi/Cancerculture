import type {
  SubmissionModerationOperation,
  SubmissionModerationPhase,
} from "@/lib/moderation/submissionModerationAuthorization";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]*$/u;

function invalidRequest(): never {
  throw Object.assign(new Error("Invalid moderation request"), {
    status: 422,
  });
}

export function parseSubmissionModerationRequest(
  value: unknown,
  operation: SubmissionModerationOperation
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest();
  }
  const body = value as Record<string, unknown>;
  const expectedPhase = body.expectedPhase;
  const reasonCode =
    typeof body.reasonCode === "string"
      ? body.reasonCode.trim().toLowerCase()
      : "";
  const reasonText =
    typeof body.reasonText === "string" && body.reasonText.trim()
      ? body.reasonText.trim()
      : null;
  const disqualificationType =
    typeof body.disqualificationType === "string" &&
    body.disqualificationType.trim()
      ? body.disqualificationType.trim().toLowerCase()
      : null;

  if (
    !Number.isSafeInteger(body.cycleId) ||
    Number(body.cycleId) <= 0 ||
    !Number.isSafeInteger(body.submissionId) ||
    Number(body.submissionId) <= 0 ||
    (expectedPhase !== "submission_open" &&
      expectedPhase !== "voting_open" &&
      expectedPhase !== "voting_closed") ||
    typeof body.expectedIsDisqualified !== "boolean" ||
    typeof body.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(body.idempotencyKey) ||
    !REASON_CODE_PATTERN.test(reasonCode) ||
    reasonCode.length > 100 ||
    (reasonText?.length ?? 0) > 1000 ||
    (operation === "disqualify" &&
      (!disqualificationType ||
        !REASON_CODE_PATTERN.test(disqualificationType) ||
        disqualificationType.length > 100)) ||
    (operation === "reinstate" &&
      (disqualificationType !== null ||
        !reasonText ||
        reasonText.length < 3))
  ) {
    invalidRequest();
  }

  return Object.freeze({
    cycleId: Number(body.cycleId),
    submissionId: Number(body.submissionId),
    operation,
    expectedPhase: expectedPhase as SubmissionModerationPhase,
    expectedIsDisqualified: body.expectedIsDisqualified,
    disqualificationType,
    reasonCode,
    reasonText,
    idempotencyKey: body.idempotencyKey,
  });
}
