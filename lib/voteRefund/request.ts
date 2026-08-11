import { AuthError } from "@/lib/auth/AuthError";

export const MAX_VOTE_REFUND_SUBMISSIONS = 100;
export const MAX_VOTE_REFUND_ROWS = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type VoteRefundSelection = Readonly<{
  submissionId: number;
  expectedDisqualifiedAt: string;
  expectedVoteCount: number;
}>;

function invalidRequest(): never {
  throw new AuthError(
    422,
    "Invalid vote-refund request",
    "INVALID_VOTE_REFUND_REQUEST"
  );
}

function parseSelection(value: unknown): VoteRefundSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest();
  }

  const selection = value as Record<string, unknown>;
  const expectedDisqualifiedAt =
    typeof selection.expectedDisqualifiedAt === "string"
      ? selection.expectedDisqualifiedAt.trim()
      : "";

  if (
    !Number.isSafeInteger(selection.submissionId) ||
    Number(selection.submissionId) <= 0 ||
    !Number.isSafeInteger(selection.expectedVoteCount) ||
    Number(selection.expectedVoteCount) <= 0 ||
    Number(selection.expectedVoteCount) > MAX_VOTE_REFUND_ROWS ||
    expectedDisqualifiedAt.length < 10 ||
    expectedDisqualifiedAt.length > 64 ||
    !Number.isFinite(Date.parse(expectedDisqualifiedAt))
  ) {
    invalidRequest();
  }

  return Object.freeze({
    submissionId: Number(selection.submissionId),
    expectedDisqualifiedAt,
    expectedVoteCount: Number(selection.expectedVoteCount),
  });
}

export function parseVoteRefundRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest();
  }

  const body = value as Record<string, unknown>;
  const reasonText =
    typeof body.reasonText === "string" && body.reasonText.trim()
      ? body.reasonText.trim()
      : null;
  const selections = Array.isArray(body.selections)
    ? body.selections.map(parseSelection).sort((left, right) =>
        left.submissionId - right.submissionId
      )
    : [];
  const selectedIds = selections.map((selection) => selection.submissionId);
  const expectedVoteTotal = selections.reduce(
    (total, selection) => total + selection.expectedVoteCount,
    0
  );

  if (
    !Number.isSafeInteger(body.cycleId) ||
    Number(body.cycleId) <= 0 ||
    !Number.isSafeInteger(body.expectedResetCount) ||
    Number(body.expectedResetCount) < 0 ||
    !Number.isSafeInteger(body.expectedVotesPerUser) ||
    Number(body.expectedVotesPerUser) < 1 ||
    Number(body.expectedVotesPerUser) > 50 ||
    selections.length < 1 ||
    selections.length > MAX_VOTE_REFUND_SUBMISSIONS ||
    new Set(selectedIds).size !== selections.length ||
    expectedVoteTotal > MAX_VOTE_REFUND_ROWS ||
    (body.reasonText !== undefined &&
      body.reasonText !== null &&
      typeof body.reasonText !== "string") ||
    (reasonText !== null &&
      (reasonText.length < 3 || reasonText.length > 1000)) ||
    typeof body.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(body.idempotencyKey)
  ) {
    invalidRequest();
  }

  return Object.freeze({
    cycleId: Number(body.cycleId),
    expectedResetCount: Number(body.expectedResetCount),
    expectedVotesPerUser: Number(body.expectedVotesPerUser),
    selections: Object.freeze(selections),
    reasonText,
    idempotencyKey: body.idempotencyKey,
  });
}
