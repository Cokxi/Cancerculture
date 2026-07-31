import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  data: null,
  error: null,
  calls: [],
};

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

const {
  SubmissionModerationError,
  moderateSubmission,
} = await import("../../lib/moderation/moderateSubmission.ts");
const { parseSubmissionModerationRequest } = await import(
  "../../lib/moderation/submissionModerationRequest.ts"
);

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const params = {
  actorDiscordUserId: "owner",
  cycleId: 7,
  submissionId: 125,
  operation: "disqualify",
  expectedPhase: "submission_open",
  expectedIsDisqualified: false,
  disqualificationType: "manual",
  reasonCode: "policy_violation",
  reasonText: "Reviewed by the moderation team.",
  idempotencyKey: requestId,
};

test.beforeEach(() => {
  state.calls = [];
  state.error = null;
  state.data = {
    operation: "disqualify",
    requestId,
    cycleId: 7,
    submissionId: 125,
    phase: "submission_open",
    requiredCapability:
      "submissions.submission_phase.disqualify",
    changed: true,
    isDisqualified: true,
    replayed: false,
  };
});

test("the adapter calls only the single atomic RPC with server-owned actor data", async () => {
  const result = await moderateSubmission(params);

  assert.equal(result.changed, true);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], {
    name: "moderate_submission",
    parameters: {
      p_actor_discord_user_id: "owner",
      p_cycle_id: 7,
      p_submission_id: 125,
      p_operation: "disqualify",
      p_expected_phase: "submission_open",
      p_expected_is_disqualified: false,
      p_disqualification_type: "manual",
      p_reason_code: "policy_violation",
      p_reason_text: "Reviewed by the moderation team.",
      p_idempotency_key: requestId,
    },
  });
});

test("database authorization, conflicts, validation and dependency failures stay distinct", async () => {
  const cases = [
    ["SUBMISSION_MODERATION_FORBIDDEN", 403],
    ["MODERATION_PHASE_CONFLICT", 409],
    ["MODERATION_EXPECTED_STATE_CONFLICT", 409],
    ["SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT", 409],
    ["INVALID_SUBMISSION_MODERATION_REQUEST", 422],
    ["MODERATION_AUTHORIZATION_DEPENDENCY_UNAVAILABLE", 503],
    ["private SQL table detail", 503],
  ];

  for (const [message, expectedStatus] of cases) {
    state.error = { code: "P0001", message };
    await assert.rejects(moderateSubmission(params), (error) => {
      assert.ok(error instanceof SubmissionModerationError);
      assert.equal(error.status, expectedStatus);
      assert.doesNotMatch(error.message, /private SQL table detail/u);
      return true;
    });
  }
});

test("an invalid RPC response fails closed as 503", async () => {
  state.data = { changed: true };
  await assert.rejects(moderateSubmission(params), (error) => {
    assert.ok(error instanceof SubmissionModerationError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "INVALID_SUBMISSION_MODERATION_RESPONSE");
    return true;
  });
});

test("request parsing enforces phase, expected state, operation fields and rationale", () => {
  const parsed = parseSubmissionModerationRequest(
    {
      cycleId: 7,
      submissionId: 125,
      expectedPhase: "voting_open",
      expectedIsDisqualified: true,
      reasonCode: "manual_review",
      reasonText: "Reinstatement rationale.",
      disqualificationType: null,
      idempotencyKey: requestId,
      actorDiscordUserId: "ignored-client-actor",
      capabilityKey: "ignored.client.capability",
    },
    "reinstate"
  );

  assert.equal(parsed.operation, "reinstate");
  assert.equal(parsed.expectedPhase, "voting_open");
  assert.equal("actorDiscordUserId" in parsed, false);
  assert.equal("capabilityKey" in parsed, false);

  for (const invalid of [
    { ...params, expectedPhase: "voting_closed" },
    { ...params, expectedIsDisqualified: "false" },
    { ...params, idempotencyKey: "not-a-uuid" },
  ]) {
    assert.throws(
      () => parseSubmissionModerationRequest(invalid, "disqualify"),
      (error) => error?.status === 422
    );
  }

  assert.throws(
    () =>
      parseSubmissionModerationRequest(
        {
          cycleId: 7,
          submissionId: 125,
          expectedPhase: "submission_open",
          expectedIsDisqualified: true,
          reasonCode: "manual_review",
          reasonText: "",
          disqualificationType: null,
          idempotencyKey: requestId,
        },
        "reinstate"
      ),
    (error) => error?.status === 422
  );
});
