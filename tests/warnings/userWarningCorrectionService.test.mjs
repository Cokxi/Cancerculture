import assert from "node:assert/strict";
import { mock, test } from "node:test";

const actorId = "111111111111111111";
const targetId = "222222222222222222";
const warningId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18429";
const requestId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18430";
const state = { calls: [], responses: [], capabilities: [] };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return Promise.resolve(state.responses.shift() ?? { data: null, error: null });
      },
    },
  },
});

mock.module(new URL("../../lib/auth/teamAuthorization.ts", import.meta.url), {
  namedExports: {
    async requireDynamicTeamCapability(capability) {
      state.capabilities.push(capability);
      return { discord_user_id: actorId, role: "admin", isAdmin: true };
    },
  },
});

const {
  overruleTeamUserWarning,
  UserWarningCorrectionConflict,
} = await import("../../lib/warnings/userWarningVisibility.server.ts");

function targetProjection(overrides = {}) {
  return {
    outcome: "found",
    warningId,
    targetDiscordUserId: targetId,
    rowVersion: 1,
    state: "active",
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    warningId,
    state: "overruled",
    rowVersion: 2,
    recalculatedCount: 1,
    expiredCount: 0,
    activeWarningCount: 0,
    autoFlag: {
      activeWarningCount: 0,
      triggeredByActiveCount: false,
      triggeredByFourteenDay: false,
      status: "closed",
      caseId: null,
    },
    replayed: false,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    targetDiscordUserId: targetId,
    publicWarningId: warningId,
    expectedRowVersion: 1,
    reason: "Bound internal correction reason.",
    requestId,
    ...overrides,
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.responses = [];
  state.capabilities = [];
});

test("Overrule binds target and version before calling only the canonical mutation RPC", async () => {
  state.responses = [
    { data: targetProjection(), error: null },
    { data: receipt(), error: null },
  ];
  const result = await overruleTeamUserWarning(request());
  assert.deepEqual(state.capabilities, ["users.warnings.overrule"]);
  assert.deepEqual(state.calls, [
    {
      name: "get_user_warning_overrule_target",
      parameters: {
        p_actor_discord_user_id: actorId,
        p_target_discord_user_id: targetId,
        p_public_warning_id: warningId,
      },
    },
    {
      name: "overrule_user_warning",
      parameters: {
        p_actor_discord_user_id: actorId,
        p_public_warning_id: warningId,
        p_expected_row_version: 1,
        p_reason: "Bound internal correction reason.",
        p_request_id: requestId,
      },
    },
  ]);
  assert.deepEqual(result, {
    warningId,
    state: "overruled",
    rowVersion: 2,
    replayed: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /reason|targetDiscord|autoFlag|actor/iu);
});

test("target mismatch and stale version fail before the mutation RPC", async () => {
  state.responses = [{ data: { outcome: "not_found" }, error: null }];
  await assert.rejects(
    overruleTeamUserWarning(request()),
    (error) => error instanceof UserWarningCorrectionConflict &&
      error.reason === "target_mismatch",
  );
  assert.equal(state.calls.length, 1);

  state.calls = [];
  state.responses = [{ data: targetProjection({ rowVersion: 2 }), error: null }];
  await assert.rejects(
    overruleTeamUserWarning(request()),
    (error) => error instanceof UserWarningCorrectionConflict &&
      error.reason === "stale_version",
  );
  assert.equal(state.calls.length, 1);
});

test("same-request replay reaches the canonical RPC after the Warning is already overruled", async () => {
  state.responses = [
    { data: targetProjection({ rowVersion: 2, state: "overruled" }), error: null },
    { data: receipt({ replayed: true }), error: null },
  ];
  const result = await overruleTeamUserWarning(request());
  assert.equal(result.replayed, true);
  assert.equal(state.calls[1].name, "overrule_user_warning");
});

test("malformed target and receipt projections fail closed without exposing database detail", async () => {
  state.responses = [{
    data: { ...targetProjection(), correctionReason: "must not pass" },
    error: null,
  }];
  await assert.rejects(
    overruleTeamUserWarning(request()),
    (error) => error.status === 503,
  );
  assert.equal(state.calls.length, 1);

  state.calls = [];
  state.responses = [
    { data: targetProjection(), error: null },
    { data: receipt({ autoFlag: { ...receipt().autoFlag, internalCase: true } }), error: null },
  ];
  await assert.rejects(
    overruleTeamUserWarning(request()),
    (error) => error.status === 503,
  );
});

test("conflicting replay and concurrent stale outcomes stay bounded", async () => {
  const consoleError = mock.method(console, "error", () => {});
  state.responses = [
    { data: targetProjection(), error: null },
    { data: null, error: { code: "PT409", message: "USER_WARNING_IDEMPOTENCY_CONFLICT" } },
  ];
  await assert.rejects(
    overruleTeamUserWarning(request()),
    (error) => error instanceof UserWarningCorrectionConflict &&
      error.reason === "idempotency_conflict" &&
      !error.message.includes("IDEMPOTENCY"),
  );
  consoleError.mock.restore();
});
