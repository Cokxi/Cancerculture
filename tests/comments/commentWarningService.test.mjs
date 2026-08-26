import assert from "node:assert/strict";
import { mock, test } from "node:test";

const actorDiscordUserId = "warning-test-owner";
const publicCommentId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
const requestId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18425";
const state = { calls: [], capabilities: [], data: null, error: null };

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
    async getTeamAuthorizationContext() {
      state.capabilities.push("context");
      return {
        discord_user_id: actorDiscordUserId,
        role: "admin",
        isAdmin: true,
        resolvedCapabilities: [],
      };
    },
    hasResolvedTeamCapability(context, capability) {
      state.capabilities.push(capability);
      return context.isAdmin || context.resolvedCapabilities.includes(capability);
    },
    async requireDynamicTeamCapability(capability) {
      state.capabilities.push(capability);
      return {
        discord_user_id: actorDiscordUserId,
        role: "admin",
        isAdmin: true,
        resolvedCapabilities: [],
      };
    },
  },
});

const {
  issueCommunityCommentWarning,
  loadCommunityCommentWarningAccess,
  loadCommunityCommentWarningTarget,
} = await import("../../lib/comments/commentWarning.server.ts");

const issueInput = {
  publicCommentId,
  expectedObjectVersion: 3,
  expectedTextVersion: 2,
  category: "other",
  reason: "This Comment crosses the line.",
  requestId,
};

test.beforeEach(() => {
  state.calls = [];
  state.capabilities = [];
  state.error = null;
  state.data = null;
});

test("Warning access exposes one fail-closed Boolean from the active Team context", async () => {
  assert.deepEqual(await loadCommunityCommentWarningAccess(), {
    canIssueWarning: true,
  });
  assert.deepEqual(state.capabilities, ["context", "users.warnings.issue"]);
  assert.deepEqual(state.calls, []);
});

test("Warning target read rechecks exact capability and forwards server-owned actor identity", async () => {
  state.data = {
    outcome: "found",
    publicCommentId,
    objectVersion: 3,
    textVersion: 2,
    text: "Stored exact Comment text",
    available: true,
    alreadyWarned: false,
  };

  const result = await loadCommunityCommentWarningTarget(publicCommentId);

  assert.equal(result.textVersion, 2);
  assert.deepEqual(state.capabilities, ["users.warnings.issue"]);
  assert.deepEqual(state.calls, [{
    name: "get_user_warning_issue_target",
    parameters: {
      p_actor_discord_user_id: actorDiscordUserId,
      p_public_comment_id: publicCommentId,
    },
  }]);
});

test("Warning issue forwards only canonical Comment evidence and redacts the database receipt", async () => {
  state.data = {
    warningId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18429",
    sourcePublicCommentId: publicCommentId,
    targetDiscordUserId: "private-target",
    category: "other",
    tierDays: 1,
    issuedAt: "2026-08-26T15:00:00.000Z",
    recurrenceUntil: "2026-08-29T15:00:00.000Z",
    expiresAt: "2026-08-27T15:00:00.000Z",
    state: "active",
    rowVersion: 1,
    activeWarningCount: 1,
    autoFlag: { status: "closed" },
    replayed: false,
  };

  const result = await issueCommunityCommentWarning(issueInput);

  assert.deepEqual(state.capabilities, ["users.warnings.issue"]);
  assert.deepEqual(state.calls, [{
    name: "issue_user_warning",
    parameters: {
      p_actor_discord_user_id: actorDiscordUserId,
      p_source_public_comment_id: publicCommentId,
      p_expected_comment_object_version: 3,
      p_expected_comment_text_version: 2,
      p_category: "other",
      p_reason: "This Comment crosses the line.",
      p_request_id: requestId,
    },
  }]);
  assert.deepEqual(result, {
    outcome: "issued",
    publicCommentId,
    tierDays: 1,
    issuedAt: "2026-08-26T15:00:00.000Z",
    expiresAt: "2026-08-27T15:00:00.000Z",
    replayed: false,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /targetDiscord|warningId|activeWarningCount|autoFlag|recurrenceUntil/u,
  );
});

test("Warning issue rejects extra manual identity or duration input before authorization or RPC", async () => {
  for (const extra of [
    { durationDays: 14 },
    { targetDiscordUserId: "manual-target" },
    { sourceCommentId: "manual-source" },
  ]) {
    await assert.rejects(
      issueCommunityCommentWarning({ ...issueInput, ...extra }),
      (error) => error.status === 400 && error.code === "COMMENT_WARNING_INVALID",
    );
  }
  assert.deepEqual(state.capabilities, []);
  assert.deepEqual(state.calls, []);
});

test("Warning database conflicts remain distinct and private failures fail closed", async () => {
  const cases = [
    ["PT409", "USER_WARNING_SOURCE_ALREADY_USED", 409, "COMMENT_WARNING_ALREADY_ISSUED"],
    ["PT409", "USER_WARNING_STALE_SOURCE_VERSION", 409, "COMMENT_WARNING_STALE"],
    ["PT409", "USER_WARNING_IDEMPOTENCY_CONFLICT", 409, "COMMENT_WARNING_IDEMPOTENCY_CONFLICT"],
    ["42501", "private capability detail", 403, "COMMENT_WARNING_FORBIDDEN"],
    ["XX000", "private database detail", 503, "COMMENT_WARNING_UNAVAILABLE"],
  ];
  const consoleError = mock.method(console, "error", () => {});

  for (const [code, message, status, expectedCode] of cases) {
    state.error = { code, message };
    await assert.rejects(issueCommunityCommentWarning(issueInput), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, expectedCode);
      assert.doesNotMatch(error.message, /private/u);
      return true;
    });
  }

  consoleError.mock.restore();
});

test("malformed Warning target and issue receipts fail closed", async () => {
  state.data = { outcome: "found", publicCommentId };
  await assert.rejects(
    loadCommunityCommentWarningTarget(publicCommentId),
    (error) => error.status === 503 && error.code === "COMMENT_WARNING_UNAVAILABLE",
  );

  state.data = { sourcePublicCommentId: publicCommentId, tierDays: 1 };
  await assert.rejects(
    issueCommunityCommentWarning(issueInput),
    (error) => error.status === 503 && error.code === "COMMENT_WARNING_UNAVAILABLE",
  );
});
