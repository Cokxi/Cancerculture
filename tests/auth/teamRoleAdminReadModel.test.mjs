import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL =
  "https://read-model-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "read-model-test-key";

const {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} = await import("../../lib/auth/teamCapabilityRegistry.ts");
const { buildTeamRoleAdminReadModel } = await import(
  "../../lib/auth/teamRoleAdminReadModel.ts"
);

const now = "2026-07-30T12:00:00.000Z";

const role = (key, overrides = {}) => ({
  key,
  display_name: key.replaceAll("_", " "),
  description: `${key} description`,
  is_system: true,
  is_active: true,
  sort_order: 50,
  row_version: 1,
  created_at: now,
  updated_at: now,
  created_by_discord_user_id: null,
  updated_by_discord_user_id: null,
  ...overrides,
});

const catalog = (key, overrides = {}) => {
  const registered = TEAM_CAPABILITY_REGISTRY[key];
  return {
    key,
    display_name: registered.displayName,
    description: registered.description,
    category: registered.category,
    included_actions: [...registered.includedActions],
    excluded_actions: [...registered.excludedActions],
    risk_level: registered.riskLevel,
    assignable_to_non_admin: registered.assignableToNonAdmin,
    is_active: registered.lifecycle === "active",
    implementation_version: registered.implementationVersion,
    definition_hash: registered.definitionHash,
    deprecated_at: null,
    ...overrides,
  };
};

function snapshot(overrides = {}) {
  return {
    roleRows: [
      role("moderator", { sort_order: 20 }),
      role("inactive_role", {
        is_system: false,
        is_active: false,
        sort_order: 1,
      }),
      role("admin", { sort_order: 100 }),
      role("trial_moderator", { sort_order: 10 }),
    ],
    capabilityRows: REGISTERED_TEAM_CAPABILITY_KEYS.map((key) =>
      catalog(key)
    ),
    grantRows: [
      {
        role_key: "moderator",
        capability_key: "users.flag.create",
        granted_at: now,
        granted_by_discord_user_id: "owner",
        grant_reason: "Fixture grant",
      },
    ],
    memberRows: [
      {
        discord_user_id: "owner",
        discord_username: "Owner",
        role: "admin",
      },
      {
        discord_user_id: "member-1",
        discord_username: "Reviewer",
        role: "moderator",
      },
    ],
    auditRows: [],
    currentAdminDiscordUserId: "owner",
    ...overrides,
  };
}

test("roles are sorted, counted, and Admin remains immutable", () => {
  const model = buildTeamRoleAdminReadModel(snapshot());

  assert.deepEqual(
    model.roles.map((entry) => entry.key),
    ["admin", "trial_moderator", "moderator", "inactive_role"]
  );
  const admin = model.roles[0];
  const moderator = model.roles.find(
    (entry) => entry.key === "moderator"
  );
  assert.equal(admin.canDeactivate, false);
  assert.equal(admin.memberCount, 1);
  assert.equal(moderator.memberCount, 1);
  assert.equal(moderator.canDeactivate, false);
  assert.deepEqual(moderator.grantedCapabilityKeys, ["users.flag.create"]);
  assert.deepEqual(
    model.activeNonAdminRoles.map((entry) => entry.key),
    ["trial_moderator", "moderator"]
  );
  assert.equal(model.members[0].isAdmin, true);
  assert.equal(model.members[0].isCurrentAdmin, true);
});

test("capabilities are data-driven and a database-only fixture stays visible", () => {
  const fixtureCapability = {
    ...catalog("users.flag.create"),
    key: "future.fixture.capability",
    display_name: "Future Fixture",
    definition_hash: "f".repeat(64),
  };
  const model = buildTeamRoleAdminReadModel(
    snapshot({
      capabilityRows: [
        ...REGISTERED_TEAM_CAPABILITY_KEYS.map((key) =>
          catalog(key)
        ),
        fixtureCapability,
      ],
    })
  );
  const fixture = model.capabilities.find(
    (entry) => entry.key === fixtureCapability.key
  );

  assert.ok(fixture);
  assert.equal(fixture.syncStatus, "code_missing");
  assert.equal(fixture.mutable, false);
});

test("a safe database-only tombstone is absent from Roles & Permissions and drafts", () => {
  const tombstone = {
    ...catalog("users.flag.create"),
    key: "test.compatibility.tombstone",
    display_name: "Compatibility Tombstone",
    is_active: false,
    assignable_to_non_admin: false,
    definition_hash: "e".repeat(64),
  };
  const model = buildTeamRoleAdminReadModel(
    snapshot({
      capabilityRows: [
        ...REGISTERED_TEAM_CAPABILITY_KEYS.map((key) => catalog(key)),
        tombstone,
      ],
    })
  );

  assert.equal(
    model.capabilities.some((entry) => entry.key === tombstone.key),
    false
  );
  assert.equal(
    JSON.stringify(model.capabilities).includes(tombstone.key),
    false
  );
});

test("all twenty-five active registered capabilities appear in Roles & Permissions and drafts", () => {
  const model = buildTeamRoleAdminReadModel(snapshot());

  assert.deepEqual(
    model.capabilities.map((entry) => entry.key).sort(),
    [...ACTIVE_TEAM_CAPABILITY_KEYS].sort()
  );
  assert.equal(model.capabilities.length, 25);
  assert.equal(
    model.capabilities.every(
      (capability) => capability.mutable && capability.isActive
    ),
    true
  );
});

test("every registry and catalog drift state disables mutation", () => {
  const variants = [
    ["catalog_missing", []],
    [
      "inactive",
      [catalog("users.flag.create", { is_active: false })],
    ],
    [
      "not_assignable",
      [
        catalog("users.flag.create", {
          assignable_to_non_admin: false,
        }),
      ],
    ],
    [
      "version_mismatch",
      [
        catalog("users.flag.create", {
          implementation_version: 999,
        }),
      ],
    ],
    [
      "definition_mismatch",
      [
        catalog("users.flag.create", {
          definition_hash: "0".repeat(64),
        }),
      ],
    ],
  ];

  for (const [expectedStatus, capabilityRows] of variants) {
    const model = buildTeamRoleAdminReadModel(
      snapshot({ capabilityRows })
    );
    const capability = model.capabilities.find(
      (entry) => entry.key === "users.flag.create"
    );
    assert.equal(capability.syncStatus, expectedStatus);
    assert.equal(capability.mutable, false);
  }

  const synchronized = buildTeamRoleAdminReadModel(
    snapshot({
      capabilityRows: [catalog("users.flag.create")],
    })
  ).capabilities.find((entry) => entry.key === "users.flag.create");
  assert.equal(synchronized.syncStatus, "synchronized");
  assert.equal(synchronized.mutable, true);
});

test("the read model exposes only the intended member and audit projection", () => {
  const model = buildTeamRoleAdminReadModel(
    snapshot({
      auditRows: [
        {
          id: "audit-1",
          occurred_at: now,
          actor_discord_user_id: "owner",
          actor_role_key: "admin",
          event_type: "role_updated",
          target_role_key: "moderator",
          target_discord_user_id: null,
          capability_key: null,
          before_state: { display_name: "Old" },
          after_state: { display_name: "New" },
          reason: "Clearer name",
          request_id: "request-1",
        },
      ],
    })
  );

  assert.deepEqual(Object.keys(model.members[0]).sort(), [
    "discordUserId",
    "displayName",
    "isAdmin",
    "isCurrentAdmin",
    "roleKey",
  ]);
  assert.equal(model.audit[0].eventType, "role_updated");
  assert.deepEqual(model.audit[0].beforeState, {
    display_name: "Old",
  });
});
