import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  rpcCalls: [],
  rpcData: { changed: true },
  rpcError: null,
  catalogData: null,
  catalogError: null,
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.rpcCalls.push({ name, parameters });
        return Promise.resolve({
          data: state.rpcData,
          error: state.rpcError,
        });
      },
      from(table) {
        assert.equal(table, "capability_catalog");
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: state.catalogData,
              error: state.catalogError,
            });
          },
        };
      },
    },
  },
});

const { TEAM_CAPABILITY_REGISTRY } = await import(
  "../../lib/auth/teamCapabilityRegistry.ts"
);
const {
  TeamRoleMutationError,
  executeTeamRoleMutation,
} = await import("../../lib/auth/teamRoleMutations.ts");

const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const common = {
  reason: "Approved change",
  idempotencyKey,
};

test.beforeEach(() => {
  state.rpcCalls = [];
  state.rpcData = { changed: true };
  state.rpcError = null;
  state.catalogData = null;
  state.catalogError = null;
});

test("every operation delegates to its one hardened RPC", async () => {
  const flag = TEAM_CAPABILITY_REGISTRY["users.flag"];
  state.catalogData = {
    key: flag.key,
    is_active: true,
    assignable_to_non_admin: true,
    implementation_version: flag.implementationVersion,
    definition_hash: flag.definitionHash,
  };
  const operations = [
    [
      "create_team_role",
      {
        operation: "create_role",
        displayName: "Review Team",
        description: "Reviews",
        sortOrder: 40,
        ...common,
      },
    ],
    [
      "update_team_role",
      {
        operation: "update_role",
        roleKey: "custom_reviewers",
        displayName: "Review Team",
        description: "Reviews",
        sortOrder: 41,
        expectedRowVersion: 2,
        ...common,
      },
    ],
    [
      "set_team_role_active",
      {
        operation: "set_role_active",
        roleKey: "custom_reviewers",
        isActive: false,
        expectedRowVersion: 2,
        ...common,
      },
    ],
    [
      "set_team_role_capability",
      {
        operation: "set_role_capability",
        roleKey: "custom_reviewers",
        capabilityKey: flag.key,
        granted: true,
        expectedRoleRowVersion: 2,
        expectedCapabilityImplementationVersion:
          flag.implementationVersion,
        expectedCapabilityDefinitionHash: flag.definitionHash,
        ...common,
      },
    ],
    [
      "set_team_member_non_admin_role",
      {
        operation: "set_member_non_admin_role",
        targetDiscordUserId: "member",
        newRoleKey: "custom_reviewers",
        expectedPreviousRoleKey: "moderator",
        ...common,
      },
    ],
    [
      "set_team_member_admin_role",
      {
        operation: "set_member_admin_role",
        targetDiscordUserId: "member",
        isAdmin: true,
        expectedPreviousRoleKey: "moderator",
        fallbackRoleKey: null,
        confirmationWord: "ADMIN",
        ...common,
      },
    ],
  ];

  for (const [expectedName, payload] of operations) {
    state.rpcCalls = [];
    await executeTeamRoleMutation("owner", payload);
    assert.equal(state.rpcCalls.length, 1);
    assert.equal(state.rpcCalls[0].name, expectedName);
    assert.equal(
      state.rpcCalls[0].parameters.p_actor_discord_user_id,
      "owner"
    );
    assert.equal(
      Object.values(state.rpcCalls[0].parameters).includes(
        payload.confirmationWord
      ),
      false
    );
  }
});

test("database conflicts map to safe 409 errors without SQL details", async () => {
  state.rpcError = {
    code: "P0001",
    message:
      "TEAM_ROLE_VERSION_CONFLICT private table and SQL details",
  };

  await assert.rejects(
    executeTeamRoleMutation("owner", {
      operation: "set_role_active",
      roleKey: "moderator",
      isActive: false,
      expectedRowVersion: 2,
      ...common,
    }),
    (error) => {
      assert.ok(error instanceof TeamRoleMutationError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "TEAM_ROLE_VERSION_CONFLICT");
      assert.doesNotMatch(error.message, /private table|SQL/u);
      return true;
    }
  );
});

test("registry drift fails closed before a capability RPC", async () => {
  const flag = TEAM_CAPABILITY_REGISTRY["users.flag"];
  state.catalogData = {
    key: flag.key,
    is_active: true,
    assignable_to_non_admin: true,
    implementation_version: flag.implementationVersion,
    definition_hash: "0".repeat(64),
  };

  await assert.rejects(
    executeTeamRoleMutation("owner", {
      operation: "set_role_capability",
      roleKey: "moderator",
      capabilityKey: flag.key,
      granted: true,
      expectedRoleRowVersion: 2,
      expectedCapabilityImplementationVersion:
        flag.implementationVersion,
      expectedCapabilityDefinitionHash: flag.definitionHash,
      ...common,
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "CAPABILITY_REGISTRY_DRIFT");
      return true;
    }
  );
  assert.deepEqual(state.rpcCalls, []);
});

test("unexpected dependency failures map to a generic 503", async () => {
  state.rpcError = {
    code: "XX000",
    message: "relation private_schema.secret_table failed",
  };

  await assert.rejects(
    executeTeamRoleMutation("owner", {
      operation: "set_member_non_admin_role",
      targetDiscordUserId: "member",
      newRoleKey: "moderator",
      expectedPreviousRoleKey: "trial_moderator",
      ...common,
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "TEAM_ROLE_MUTATION_UNAVAILABLE");
      assert.doesNotMatch(error.message, /private_schema|secret_table/u);
      return true;
    }
  );
});
