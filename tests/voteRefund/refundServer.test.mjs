import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { calls: [], data: null, error: null };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return Promise.resolve({ data: state.data, error: state.error });
      },
    },
  },
});

const { refundDisqualifiedVotes } = await import(
  "../../lib/voteRefund/refund.server.ts"
);

const params = {
  actorDiscordUserId: "owner",
  cycleId: 19,
  expectedResetCount: 3,
  expectedVotesPerUser: 5,
  selections: [
    {
      submissionId: 11,
      expectedDisqualifiedAt: "2026-08-08T07:00:00.000Z",
      expectedVoteCount: 7,
    },
  ],
  reasonText: "Final DQ confirmed.",
  idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
};

test.beforeEach(() => {
  state.calls = [];
  state.error = null;
  state.data = {
    requestId: params.idempotencyKey,
    cycleId: 19,
    resetCount: 3,
    votesPerUser: 5,
    selectionCount: 1,
    refundedVoteCount: 7,
    affectedVoterCount: 5,
    submissionRefunds: [{ submissionId: 11, refundedVoteCount: 7 }],
    replayed: false,
  };
});

test("the server adapter performs exactly one atomic RPC with server-owned actor data", async () => {
  const result = await refundDisqualifiedVotes(params);

  assert.equal(result.refundedVoteCount, 7);
  assert.deepEqual(state.calls, [
    {
      name: "refund_disqualified_votes",
      parameters: {
        p_actor_discord_user_id: "owner",
        p_cycle_id: 19,
        p_expected_reset_count: 3,
        p_expected_votes_per_user: 5,
        p_selections: params.selections,
        p_reason_text: "Final DQ confirmed.",
        p_idempotency_key: params.idempotencyKey,
      },
    },
  ]);
});

test("database authorization, stale state, limits, validation and unknown failures remain distinct", async () => {
  const cases = [
    ["VOTE_REFUND_FORBIDDEN", 403],
    ["VOTE_REFUND_LIMIT_EXCEEDED", 413],
    ["INVALID_VOTE_REFUND_REQUEST", 422],
    ["VOTE_REFUND_PHASE_CLOSED", 409],
    ["VOTE_REFUND_DISQUALIFICATION_CONFLICT", 409],
    ["VOTE_REFUND_COUNT_CONFLICT", 409],
    ["private database detail", 503],
  ];
  const consoleError = mock.method(console, "error", () => {});

  for (const [message, status] of cases) {
    state.error = { code: "P0001", message };
    await assert.rejects(refundDisqualifiedVotes(params), (error) => {
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private database detail/u);
      return true;
    });
  }

  consoleError.mock.restore();
});

test("invalid database responses fail closed", async () => {
  state.data = { refundedVoteCount: 7 };
  await assert.rejects(refundDisqualifiedVotes(params), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "VOTE_REFUND_UNAVAILABLE");
    return true;
  });
});
