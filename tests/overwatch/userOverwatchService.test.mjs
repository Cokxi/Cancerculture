import assert from "node:assert/strict";
import { mock, test } from "node:test";

const actorId = "111111111111111111";
const targetId = "222222222222222222";
const entryId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18429";
const profileId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18430";
const requestId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18431";
const openedAt = "2026-08-27T10:00:00.000Z";
const closedAt = "2026-08-27T11:00:00.000Z";
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
  addUserToOverwatch,
  loadUserOverwatchEntries,
  prepareUserOverwatchTarget,
  removeUserFromOverwatch,
  UserOverwatchConflict,
} = await import("../../lib/overwatch/userOverwatch.server.ts");

function targetProjection(overrides = {}) {
  return {
    outcome: "found",
    targetDiscordUserId: targetId,
    currentState: "absent",
    entryId: null,
    generation: 0,
    rowVersion: 0,
    ...overrides,
  };
}

function event(eventType, entryRowVersion, occurredAt, reason) {
  return {
    eventType,
    reason,
    actorDisplayName: "Owner",
    actorRoleKey: "admin",
    entryRowVersion,
    occurredAt,
  };
}

function entry(overrides = {}) {
  return {
    entryId,
    targetDiscordUserId: targetId,
    publicProfileId: profileId,
    currentDiscordUsername: "target-user",
    currentDiscordHandle: "target-user",
    currentDisplayName: "Target User",
    currentGuildNickname: null,
    generation: 1,
    state: "active",
    rowVersion: 1,
    openedAt,
    closedAt: null,
    events: [event("added", 1, openedAt, "Second opinion requested.")],
    ...overrides,
  };
}

function receipt(operation, overrides = {}) {
  return {
    operation,
    entryId,
    targetDiscordUserId: targetId,
    generation: 1,
    state: operation === "add" ? "active" : "removed",
    rowVersion: operation === "add" ? 1 : 2,
    occurredAt: operation === "add" ? openedAt : closedAt,
    replayed: false,
    ...overrides,
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.responses = [];
  state.capabilities = [];
});

test("manage target preparation is minimal, exact-capability, and fail-closed", async () => {
  state.responses = [{ data: targetProjection(), error: null }];
  const result = await prepareUserOverwatchTarget(targetId);
  assert.deepEqual(state.capabilities, ["users.overwatch.manage"]);
  assert.deepEqual(result, {
    targetDiscordUserId: targetId,
    currentState: "absent",
    entryId: null,
    generation: 0,
    rowVersion: 0,
  });
  assert.deepEqual(state.calls[0], {
    name: "get_user_overwatch_manage_target",
    parameters: {
      p_actor_discord_user_id: actorId,
      p_target_discord_user_id: targetId,
    },
  });

  state.calls = [];
  state.responses = [{ data: { ...targetProjection(), internalReason: "leak" }, error: null }];
  await assert.rejects(
    prepareUserOverwatchTarget(targetId),
    (error) => error.status === 503,
  );
});

test("active and immutable history reads require only exact View and exact DTO shapes", async () => {
  state.responses = [{ data: { items: [entry()] }, error: null }];
  const active = await loadUserOverwatchEntries("active");
  assert.deepEqual(state.capabilities, ["users.overwatch.view"]);
  assert.equal(active.length, 1);
  assert.equal(active[0].events[0].reason, "Second opinion requested.");

  state.capabilities = [];
  state.responses = [{
    data: {
      items: [entry({
        state: "removed",
        rowVersion: 2,
        closedAt,
        events: [
          event("added", 1, openedAt, "Second opinion requested."),
          event("removed", 2, closedAt, "Second opinion completed."),
        ],
      })],
    },
    error: null,
  }];
  const history = await loadUserOverwatchEntries("history");
  assert.deepEqual(state.capabilities, ["users.overwatch.view"]);
  assert.equal(history[0].events.length, 2);
  assert.equal(history[0].state, "removed");
});

test("Add binds the selected target, expected state/version, reason, and request UUID", async () => {
  state.responses = [
    { data: targetProjection(), error: null },
    { data: receipt("add"), error: null },
  ];
  const result = await addUserToOverwatch({
    targetDiscordUserId: targetId,
    expectedState: "absent",
    expectedRowVersion: 0,
    reason: "  Second opinion requested.  ",
    requestId,
  });
  assert.deepEqual(state.capabilities, ["users.overwatch.manage"]);
  assert.equal(result.state, "active");
  assert.deepEqual(state.calls.map((call) => call.name), [
    "get_user_overwatch_manage_target",
    "add_user_to_overwatch",
  ]);
  assert.deepEqual(state.calls[1].parameters, {
    p_actor_discord_user_id: actorId,
    p_target_discord_user_id: targetId,
    p_expected_state: "absent",
    p_expected_row_version: 0,
    p_reason: "Second opinion requested.",
    p_request_id: requestId,
  });
});

test("identical Add replay reaches the canonical request ledger after state changed", async () => {
  state.responses = [
    {
      data: targetProjection({
        currentState: "active",
        entryId,
        generation: 1,
        rowVersion: 1,
      }),
      error: null,
    },
    { data: receipt("add", { replayed: true }), error: null },
  ];
  const result = await addUserToOverwatch({
    targetDiscordUserId: targetId,
    expectedState: "absent",
    expectedRowVersion: 0,
    reason: "Second opinion requested.",
    requestId,
  });
  assert.equal(result.replayed, true);
  assert.equal(state.calls[1].name, "add_user_to_overwatch");
});

test("Remove binds the exact active generation and version", async () => {
  state.responses = [
    {
      data: targetProjection({
        currentState: "active",
        entryId,
        generation: 1,
        rowVersion: 1,
      }),
      error: null,
    },
    { data: receipt("remove"), error: null },
  ];
  const result = await removeUserFromOverwatch({
    targetDiscordUserId: targetId,
    entryId,
    expectedRowVersion: 1,
    reason: "Second opinion completed.",
    requestId,
  });
  assert.equal(result.state, "removed");
  assert.deepEqual(state.calls[1].parameters, {
    p_actor_discord_user_id: actorId,
    p_target_discord_user_id: targetId,
    p_public_entry_id: entryId,
    p_expected_state: "active",
    p_expected_row_version: 1,
    p_reason: "Second opinion completed.",
    p_request_id: requestId,
  });
});

test("malformed projections, conflicting replay, and dependency errors fail closed", async () => {
  state.responses = [{ data: { items: [entry({ rowVersion: 7 })] }, error: null }];
  await assert.rejects(
    loadUserOverwatchEntries("active"),
    (error) => error.status === 503,
  );

  const consoleError = mock.method(console, "error", () => {});
  state.responses = [
    { data: targetProjection(), error: null },
    { data: null, error: { code: "PT409", message: "USER_OVERWATCH_IDEMPOTENCY_CONFLICT" } },
  ];
  await assert.rejects(
    addUserToOverwatch({
      targetDiscordUserId: targetId,
      expectedState: "absent",
      expectedRowVersion: 0,
      reason: "Second opinion requested.",
      requestId,
    }),
    (error) => error instanceof UserOverwatchConflict &&
      error.reason === "idempotency_conflict" &&
      !error.message.includes("IDEMPOTENCY"),
  );
  consoleError.mock.restore();
});
