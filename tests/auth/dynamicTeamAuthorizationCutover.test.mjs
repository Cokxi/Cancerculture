import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AuthError } from "../../lib/auth/AuthError.ts";

const state = {
  readCalls: 0,
  sessionCalls: 0,
  sessionError: null,
  teamAccessCalls: 0,
  result: null,
};

mock.module(new URL("../../lib/auth/teamAccess.server.ts", import.meta.url), {
  namedExports: {
    requireTeamAreaAccess: async (session) => {
      assert.equal(session.discord_user_id, "team-user-1");
      state.teamAccessCalls += 1;
    },
  },
});

function resolved(roleKey, resolvedCapabilities = []) {
  return {
    status: "resolved",
    roleKey,
    isAdmin: roleKey === "admin",
    resolvedCapabilities,
    diagnostics: [],
  };
}

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    requireSession: async () => {
      state.sessionCalls += 1;
      if (state.sessionError) throw state.sessionError;
      return {
        discord_user_id: "team-user-1",
        session_id: "00000000-0000-4000-8000-000000000001",
      };
    },
  },
});

mock.module(
  new URL(
    "../../lib/auth/readDynamicTeamAuthorization.ts",
    import.meta.url
  ),
  {
    namedExports: {
      readDynamicTeamAuthorizationForDiscordUserId: async (
        discordUserId
      ) => {
        state.readCalls += 1;
        assert.equal(discordUserId, "team-user-1");
        return state.result;
      },
    },
  }
);

const {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} = await import("../../lib/auth/teamAuthorization.ts");

test.beforeEach(() => {
  state.readCalls = 0;
  state.sessionCalls = 0;
  state.sessionError = null;
  state.teamAccessCalls = 0;
  state.result = resolved("trial_moderator", [
    "submissions.submission_phase.moderate",
    "users.flag.create",
    "users.flag.view",
    "users.flag.review",
    "users.directory.basic.view",
  ]);
});

test("admin is a hard owner for every registered capability without grants", async () => {
  state.result = resolved("admin");
  const context = await getTeamAuthorizationContext();

  assert.equal(context.isAdmin, true);
  assert.deepEqual(context.resolvedCapabilities, []);

  for (const capabilityKey of [
    "submissions.submission_phase.moderate",
    "users.flag.create",
    "users.flag.view",
    "users.flag.review",
    "users.directory.basic.view",
  ]) {
    assert.equal(
      hasResolvedTeamCapability(context, capabilityKey),
      true
    );
    assert.equal(
      (await requireDynamicTeamCapability(capabilityKey)).isAdmin,
      true
    );
  }
});

test("seed and future active non-admin roles are authorized only by explicit grants", async () => {
  for (const roleKey of [
    "trial_moderator",
    "moderator",
    "super_moderator",
    "future_custom_role",
  ]) {
    state.result = resolved(roleKey, ["users.flag.create"]);

    const context = await requireDynamicTeamCapability("users.flag.create");
    assert.equal(context.role, roleKey);
    assert.equal(context.isAdmin, false);
    assert.equal(
      hasResolvedTeamCapability(
        context,
        "users.directory.basic.view"
      ),
      false
    );
  }
});

test("a missing grant denies access without consulting the static matrix", async () => {
  state.result = resolved("trial_moderator", []);

  await assert.rejects(
    requireDynamicTeamCapability(
      "submissions.submission_phase.moderate"
    ),
    {
      status: 403,
      code: "TEAM_CAPABILITY_DENIED",
    }
  );
});

test("normal users, inactive roles, unknown roles, and legacy mod fail with 403", async () => {
  for (const result of [
    {
      status: "not_team_member",
      roleKey: null,
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
    {
      status: "inactive_role",
      roleKey: "moderator",
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
    {
      status: "unknown_role",
      roleKey: "future_unknown_role",
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
    {
      status: "unknown_role",
      roleKey: "mod",
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
  ]) {
    state.result = result;
    await assert.rejects(getTeamAuthorizationContext(), {
      status: 403,
      code: "TEAM_ACCESS_DENIED",
    });
  }
});

test("dependency failures, drift, and structural contradictions fail with 503", async () => {
  for (const result of [
    {
      status: "dependency_unavailable",
      roleKey: null,
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
    {
      status: "registry_drift",
      roleKey: "moderator",
      isAdmin: false,
      resolvedCapabilities: [],
      diagnostics: [],
    },
    {
      status: "resolved",
      roleKey: "custom_role",
      isAdmin: true,
      resolvedCapabilities: [],
      diagnostics: [],
    },
  ]) {
    state.result = result;
    await assert.rejects(getTeamAuthorizationContext(), {
      status: 503,
      code: "TEAM_AUTHORIZATION_UNAVAILABLE",
    });
  }
});

test("missing or revoked sessions stop before dynamic authorization", async () => {
  state.sessionError = new AuthError(
    401,
    "Not authenticated",
    "NOT_AUTHENTICATED"
  );

  await assert.rejects(getTeamAuthorizationContext(), {
    status: 401,
    code: "NOT_AUTHENTICATED",
  });
  assert.equal(state.readCalls, 0);
});

test("authorization is resolved afresh on every request without a capability cache", async () => {
  assert.equal(
    (
      await requireDynamicTeamCapability(
        "users.directory.basic.view"
      )
    ).role,
    "trial_moderator"
  );

  state.result = resolved("trial_moderator", []);
  await assert.rejects(
    requireDynamicTeamCapability("users.directory.basic.view"),
    { status: 403 }
  );

  assert.equal(state.sessionCalls, 2);
  assert.equal(state.readCalls, 2);
});
