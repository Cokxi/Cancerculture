import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../../lib/auth/AuthError.ts";
import { parseVoteRefundRequest } from "../../lib/voteRefund/request.ts";

const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";

function validRequest() {
  return {
    cycleId: 19,
    expectedResetCount: 3,
    expectedVotesPerUser: 5,
    selections: [
      {
        submissionId: 22,
        expectedDisqualifiedAt: "2026-08-08T08:00:00.000Z",
        expectedVoteCount: 4,
      },
      {
        submissionId: 11,
        expectedDisqualifiedAt: "2026-08-08T07:00:00.000Z",
        expectedVoteCount: 7,
      },
    ],
    reasonText: "  Final DQ confirmed by moderation.  ",
    idempotencyKey,
  };
}

test("the parser canonicalizes explicit selections and dynamic cycle expectations", () => {
  const parsed = parseVoteRefundRequest(validRequest());

  assert.deepEqual(parsed, {
    cycleId: 19,
    expectedResetCount: 3,
    expectedVotesPerUser: 5,
    selections: [
      {
        submissionId: 11,
        expectedDisqualifiedAt: "2026-08-08T07:00:00.000Z",
        expectedVoteCount: 7,
      },
      {
        submissionId: 22,
        expectedDisqualifiedAt: "2026-08-08T08:00:00.000Z",
        expectedVoteCount: 4,
      },
    ],
    reasonText: "Final DQ confirmed by moderation.",
    idempotencyKey,
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.selections), true);
});

test("vote limits accept 50 and reject values outside 1 through 50", () => {
  assert.equal(
    parseVoteRefundRequest({
      ...validRequest(),
      expectedVotesPerUser: 50,
    }).expectedVotesPerUser,
    50
  );
  assert.throws(
    () =>
      parseVoteRefundRequest({
        ...validRequest(),
        expectedVotesPerUser: 51,
      }),
    (error) =>
      error instanceof AuthError &&
      error.code === "INVALID_VOTE_REFUND_REQUEST"
  );
});

test("duplicates, empty selections, invalid expectations, and oversized totals fail closed", () => {
  const first = validRequest().selections[0];
  const invalidRequests = [
    { ...validRequest(), selections: [] },
    { ...validRequest(), selections: [first, first] },
    { ...validRequest(), expectedVotesPerUser: 0 },
    { ...validRequest(), reasonText: "x" },
    { ...validRequest(), reasonText: { unexpected: true } },
    { ...validRequest(), idempotencyKey: "not-a-uuid" },
    {
      ...validRequest(),
      selections: [
        { ...first, submissionId: 1, expectedVoteCount: 10_000 },
        { ...first, submissionId: 2, expectedVoteCount: 1 },
      ],
    },
  ];

  for (const request of invalidRequests) {
    assert.throws(
      () => parseVoteRefundRequest(request),
      (error) =>
        error instanceof AuthError &&
        error.status === 422 &&
        error.code === "INVALID_VOTE_REFUND_REQUEST"
    );
  }
});

test("the optional audit note canonicalizes blank, null and missing values", () => {
  for (const request of [
    { ...validRequest(), reasonText: "  " },
    { ...validRequest(), reasonText: null },
    Object.fromEntries(
      Object.entries(validRequest()).filter(([key]) => key !== "reasonText")
    ),
  ]) {
    assert.equal(parseVoteRefundRequest(request).reasonText, null);
  }
});
