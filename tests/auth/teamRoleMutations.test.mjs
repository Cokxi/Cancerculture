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
      "apply_team_role_capability_changes",
      {
        operation: "apply_team_role_capability_changes",
        roleSnapshots: [
          {
            role_key: "custom_reviewers",
            expected_row_version: 2,
          },
        ],
        capabilitySnapshots: [
          {
            capability_key: flag.key,
            expected_implementation_version:
              flag.implementationVersion,
            expected_definition_hash: flag.definitionHash,
          },
        ],
        changes: [
          {
            role_key: "custom_reviewers",
            capability_key: flag.key,
            desired_granted: true,
          },
        ],
        confirmationWord: "SAVE",
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
    [
      "add_team_member",
      {
        operation: "add_team_member",
        targetDiscordUserId: "123456789012345678",
        initialRoleKey: "custom_reviewers",
        confirmationWord: "ADD",
        ...common,
      },
    ],
    [
      "remove_team_member",
      {
        operation: "remove_team_member",
        targetDiscordUserId: "123456789012345678",
        expectedPreviousRoleKey: "custom_reviewers",
        confirmationWord: "REMOVE",
        ...common,
      },
    ],
  ];

  for (const [expectedName, payload] of operations) {
    state.rpcCalls = [];
    if (
      expectedName === "add_team_member" ||
      expectedName === "remove_team_member"
    ) {
      state.rpcData = {
        operation: expectedName,
        changed: true,
        targetDiscordUserId: payload.targetDiscordUserId,
        previousRole:
          expectedName === "remove_team_member"
            ? payload.expectedPreviousRoleKey
            : null,
        newRole:
          expectedName === "add_team_member"
            ? payload.initialRoleKey
            : null,
        ignoredDatabaseField: "must not reach the browser",
      };
    } else if (
      expectedName === "apply_team_role_capability_changes"
    ) {
      state.rpcData = {
        operation: expectedName,
        batchId: "223e4567-e89b-42d3-a456-426614174000",
        replayed: false,
        submittedCount: 1,
        changedCount: 1,
        noopCount: 0,
        grantCount: 1,
        revokeCount: 0,
        affectedRoles: [
          { roleKey: "custom_reviewers", rowVersion: 3 },
        ],
        ignoredDatabaseField: "must not reach the browser",
      };
    } else {
      state.rpcData = { changed: true };
    }
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
    if (expectedName === "add_team_member") {
      assert.equal(
        state.rpcCalls[0].parameters.p_expected_absent,
        true
      );
      assert.equal(
        Object.hasOwn(payload, "expectedAbsent"),
        false
      );
    }
  }
});

test("the batch wrapper calls only the exact RPC parameters and normalizes replay results", async () => {
  const flag = TEAM_CAPABILITY_REGISTRY["users.flag"];
  const roleSnapshots = [
    { role_key: "moderator", expected_row_version: 4 },
  ];
  const capabilitySnapshots = [
    {
      capability_key: flag.key,
      expected_implementation_version: flag.implementationVersion,
      expected_definition_hash: flag.definitionHash,
    },
  ];
  const changes = [
    {
      role_key: "moderator",
      capability_key: flag.key,
      desired_granted: false,
    },
  ];
  state.rpcData = {
    operation: "apply_team_role_capability_changes",
    batchId: "223e4567-e89b-42d3-a456-426614174000",
    replayed: true,
    submittedCount: 1,
    changedCount: 1,
    noopCount: 0,
    grantCount: 0,
    revokeCount: 1,
    affectedRoles: [{ roleKey: "moderator", rowVersion: 5 }],
    requestPayload: { actorDiscordUserId: "must-not-leak" },
    ledgerRow: "must-not-leak",
  };

  const result = await executeTeamRoleMutation("owner", {
    operation: "apply_team_role_capability_changes",
    roleSnapshots,
    capabilitySnapshots,
    changes,
    confirmationWord: "SAVE",
    ...common,
  });

  assert.deepEqual(state.rpcCalls, [
    {
      name: "apply_team_role_capability_changes",
      parameters: {
        p_actor_discord_user_id: "owner",
        p_role_snapshots: roleSnapshots,
        p_capability_snapshots: capabilitySnapshots,
        p_changes: changes,
        p_reason: common.reason,
        p_idempotency_key: common.idempotencyKey,
      },
    },
  ]);
  assert.deepEqual(result, {
    operation: "apply_team_role_capability_changes",
    batchId: "223e4567-e89b-42d3-a456-426614174000",
    replayed: true,
    submittedCount: 1,
    changedCount: 1,
    noopCount: 0,
    grantCount: 0,
    revokeCount: 1,
    affectedRoles: [{ roleKey: "moderator", rowVersion: 5 }],
  });
});

test("batch conflicts are specific and never expose database details", async () => {
  const flag = TEAM_CAPABILITY_REGISTRY["users.flag"];
  const payload = {
    operation: "apply_team_role_capability_changes",
    roleSnapshots: [
      { role_key: "moderator", expected_row_version: 4 },
    ],
    capabilitySnapshots: [
      {
        capability_key: flag.key,
        expected_implementation_version: flag.implementationVersion,
        expected_definition_hash: flag.definitionHash,
      },
    ],
    changes: [
      {
        role_key: "moderator",
        capability_key: flag.key,
        desired_granted: false,
      },
    ],
    confirmationWord: "SAVE",
    ...common,
  };
  const cases = [
    ["TEAM_ROLE_VERSION_CONFLICT", 409],
    ["CAPABILITY_IMPLEMENTATION_VERSION_CONFLICT", 409],
    ["CAPABILITY_DEFINITION_CONFLICT", 409],
    ["CAPABILITY_INACTIVE", 409],
    ["CAPABILITY_NOT_ASSIGNABLE", 409],
    ["TEAM_ROLE_INACTIVE", 409],
    ["TEAM_AUTH_IDEMPOTENCY_CONFLICT", 409],
    ["ACTOR_NOT_ADMIN", 403],
    ["INVALID_CAPABILITY_BATCH_SHAPE", 400],
  ];

  for (const [databaseCode, status] of cases) {
    state.rpcError = {
      code: "P0001",
      message: `${databaseCode} private_schema.secret_table constraint`,
    };
    await assert.rejects(
      executeTeamRoleMutation("owner", payload),
      (error) => {
        assert.equal(error.status, status);
        assert.doesNotMatch(
          error.message,
          /private_schema|secret_table|constraint/u,
        );
        return true;
      },
    );
  }
});

test("batch registry drift fails closed without an RPC", async () => {
  const flag = TEAM_CAPABILITY_REGISTRY["users.flag"];
  await assert.rejects(
    executeTeamRoleMutation("owner", {
      operation: "apply_team_role_capability_changes",
      roleSnapshots: [
        { role_key: "moderator", expected_row_version: 4 },
      ],
      capabilitySnapshots: [
        {
          capability_key: flag.key,
          expected_implementation_version:
            flag.implementationVersion,
          expected_definition_hash: "0".repeat(64),
        },
      ],
      changes: [
        {
          role_key: "moderator",
          capability_key: flag.key,
          desired_granted: true,
        },
      ],
      confirmationWord: "SAVE",
      ...common,
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "CAPABILITY_REGISTRY_DRIFT");
      return true;
    },
  );
  assert.deepEqual(state.rpcCalls, []);
});

test("member mutation responses are reduced to the typed browser contract", async () => {
  state.rpcData = {
    operation: "add_team_member",
    changed: true,
    targetDiscordUserId: "123456789012345678",
    previousRole: null,
    newRole: "moderator",
    internalField: "private",
  };

  assert.deepEqual(
    await executeTeamRoleMutation("owner", {
      operation: "add_team_member",
      targetDiscordUserId: "123456789012345678",
      initialRoleKey: "moderator",
      confirmationWord: "ADD",
      ...common,
    }),
    {
      operation: "add_team_member",
      changed: true,
      targetDiscordUserId: "123456789012345678",
      previousRole: null,
      newRole: "moderator",
    }
  );
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

test("member mutation errors are specific, safe, and never expose database details", async () => {
  const cases = [
    [
      "TARGET_IDENTITY_UNKNOWN",
      400,
      "TARGET_IDENTITY_UNKNOWN",
    ],
    [
      "TEAM_MEMBER_ALREADY_EXISTS",
      409,
      "TEAM_MEMBER_ALREADY_EXISTS",
    ],
    [
      "TEAM_MEMBER_NOT_FOUND",
      404,
      "TEAM_MEMBER_NOT_FOUND",
    ],
    [
      "TEAM_MEMBER_ROLE_CONFLICT",
      409,
      "TEAM_MEMBER_ROLE_CONFLICT",
    ],
    [
      "ADMIN_MEMBER_REMOVE_FORBIDDEN",
      403,
      "ADMIN_MEMBER_REMOVE_FORBIDDEN",
    ],
    [
      "TEAM_AUTH_IDEMPOTENCY_CONFLICT",
      409,
      "TEAM_AUTH_IDEMPOTENCY_CONFLICT",
    ],
  ];

  for (const [databaseMessage, status, code] of cases) {
    state.rpcError = {
      code: "P0001",
      message: `${databaseMessage} private_schema.secret_table`,
    };

    await assert.rejects(
      executeTeamRoleMutation("owner", {
        operation: "remove_team_member",
        targetDiscordUserId: "123456789012345678",
        expectedPreviousRoleKey: "moderator",
        confirmationWord: "REMOVE",
        ...common,
      }),
      (error) => {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.doesNotMatch(
          error.message,
          /private_schema|secret_table/u
        );
        return true;
      }
    );
  }
});
