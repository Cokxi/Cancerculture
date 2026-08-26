import assert from "node:assert/strict";
import { mock, test } from "node:test";

const actorId = "111111111111111111";
const targetId = "222222222222222222";
const warningId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18429";
const commentId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
const state = { calls: [], data: null, error: null, capabilities: [] };

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

mock.module(new URL("../../lib/auth/teamAuthorization.ts", import.meta.url), {
  namedExports: {
    async requireDynamicTeamCapability(capability) {
      state.capabilities.push(capability);
      return { discord_user_id: actorId, role: "admin", isAdmin: true };
    },
  },
});

const {
  loadOwnUserWarningDetail,
  loadTeamUserWarningHistory,
  loadTeamUserWarningSummaries,
} = await import("../../lib/warnings/userWarningVisibility.server.ts");

test.beforeEach(() => {
  state.calls = [];
  state.capabilities = [];
  state.data = null;
  state.error = null;
});

test("owner detail forwards only session and public Warning ID and accepts the exact neutral projection", async () => {
  state.data = {
    outcome: "found",
    warningId,
    category: "other",
    reason: "A bounded owner-visible reason.",
    issuedAt: "2026-08-26T12:00:00.000Z",
    effectiveStatus: "active",
    expiresAt: "2026-08-27T12:00:00.000Z",
  };
  const result = await loadOwnUserWarningDetail({
    sessionId: "session-id",
    publicWarningId: warningId,
  });
  assert.equal(result.effectiveStatus, "active");
  assert.deepEqual(state.calls, [{
    name: "get_own_user_warning_detail",
    parameters: {
      p_session_id: "session-id",
      p_public_warning_id: warningId,
    },
  }]);
  assert.doesNotMatch(JSON.stringify(result), /actor|team|autoFlag|sourceComment|discord/iu);
});

test("owner detail returns null for invalid, absent, or unauthorized identifiers", async () => {
  assert.equal(await loadOwnUserWarningDetail({
    sessionId: "session-id",
    publicWarningId: "invalid",
  }), null);
  assert.deepEqual(state.calls, []);

  state.data = { outcome: "not_found" };
  assert.equal(await loadOwnUserWarningDetail({
    sessionId: "session-id",
    publicWarningId: warningId,
  }), null);
});

test("Team history rechecks the exact read capability and parses immutable plus effective facts", async () => {
  state.data = {
    outcome: "found",
    active: false,
    activeCount: 0,
    latestActiveExpiresAt: null,
    historyHasMore: false,
    warnings: [{
      warningId,
      category: "other",
      reason: "Team-visible reason.",
      issuedAt: "2026-08-26T12:00:00.000Z",
      issuedByDisplayName: "Owner",
      issuedByRoleKey: "admin",
      sourcePublicCommentId: commentId,
      sourceSubmissionId: 24,
      sourceCommentObjectVersion: 2,
      sourceCommentTextVersion: 3,
      sourceCommentBody: "Immutable evidence",
      originalTierDays: 3,
      originalExpiresAt: "2026-08-29T12:00:00.000Z",
      effectiveTierDays: 1,
      effectiveStatus: "expired",
      effectiveExpiresAt: "2026-08-27T12:00:00.000Z",
      rowVersion: 2,
      events: [{
        eventType: "recalculated",
        occurredAt: "2026-08-26T13:00:00.000Z",
        actorKind: "system",
        actorDisplayName: null,
        actorRoleKey: null,
        reason: null,
        previousState: "active",
        newState: "active",
        previousTierDays: 3,
        newTierDays: 1,
        previousExpiresAt: "2026-08-29T12:00:00.000Z",
        newExpiresAt: "2026-08-27T12:00:00.000Z",
        warningRowVersion: 2,
      }],
    }],
  };
  const result = await loadTeamUserWarningHistory(targetId);
  assert.equal(result.warnings[0].effectiveTierDays, 1);
  assert.equal(result.warnings[0].events[0].eventType, "recalculated");
  assert.deepEqual(state.capabilities, ["users.warnings.view"]);
  assert.equal(state.calls[0].name, "get_user_warning_team_history");
});

test("Team summaries are exact-capability gated and contain no history detail", async () => {
  state.data = { items: [{
    targetDiscordUserId: targetId,
    active: true,
    activeCount: 1,
    latestActiveExpiresAt: "2026-08-27T12:00:00.000Z",
    historyCount: 2,
  }] };
  const result = await loadTeamUserWarningSummaries([targetId]);
  assert.equal(result[0].historyCount, 2);
  assert.deepEqual(state.capabilities, ["users.warnings.view"]);
  assert.doesNotMatch(JSON.stringify(result), /reason|actor|comment|autoFlag/iu);
});

test("malformed owner, Team, and database responses fail closed", async () => {
  state.data = {
    outcome: "found",
    warningId,
    category: "other",
    reason: "Reason",
    issuedAt: "2026-08-26T12:00:00.000Z",
    effectiveStatus: "active",
    expiresAt: "2026-08-27T12:00:00.000Z",
    actorIdentity: "must not pass",
  };
  await assert.rejects(
    loadOwnUserWarningDetail({ sessionId: "session-id", publicWarningId: warningId }),
    (error) => error.status === 503,
  );

  state.data = { outcome: "found", active: false, activeCount: 0, warnings: [] };
  await assert.rejects(loadTeamUserWarningHistory(targetId), (error) => error.status === 503);

  const consoleError = mock.method(console, "error", () => {});
  state.error = { code: "XX000", message: "private database details" };
  await assert.rejects(loadTeamUserWarningSummaries([targetId]), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private/u);
    return true;
  });
  consoleError.mock.restore();
});
