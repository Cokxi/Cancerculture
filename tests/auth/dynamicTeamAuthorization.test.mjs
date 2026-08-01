import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDynamicTeamAuthorizationSnapshot,
  resolveDynamicTeamAuthorizationWithLoader,
} from "../../lib/auth/dynamicTeamAuthorization.ts";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} from "../../lib/auth/teamCapabilityRegistry.ts";
import { resolveTeamAreaNavigation } from "../../lib/admin/teamAreaNavigation.ts";
import { createAccountNavigationState } from "../../lib/auth/accountNavigation.ts";

const nonAdminRoles = [
  "trial_moderator",
  "moderator",
  "super_moderator",
];
const roles = [
  { key: "admin", isActive: true },
  ...nonAdminRoles.map((key) => ({ key, isActive: true })),
];
const catalog = REGISTERED_TEAM_CAPABILITY_KEYS.map((key) => {
  const definition = TEAM_CAPABILITY_REGISTRY[key];

  return {
    key,
    isActive: definition.lifecycle === "active",
    assignableToNonAdmin: definition.lifecycle === "active",
    implementationVersion: definition.implementationVersion,
    definitionHash: definition.definitionHash,
  };
});
const grants = nonAdminRoles.flatMap((roleKey) =>
  ACTIVE_TEAM_CAPABILITY_KEYS.map((capabilityKey) => ({
    roleKey,
    capabilityKey,
  }))
);
const newlyActivatedKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
];

function snapshot(roleKey, overrides = {}) {
  return {
    teamMemberRoleKey: roleKey,
    roles,
    catalog,
    grants,
    ...overrides,
  };
}

test("admin resolves as the hard owner without capability grants", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("admin", { catalog: [], grants: [] })
  );

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.roleKey, "admin");
  assert.equal(resolved.isAdmin, true);
  assert.deepEqual(resolved.resolvedCapabilities, []);
  assert.deepEqual(resolved.diagnostics, []);
});

for (const roleKey of nonAdminRoles) {
  test(`${roleKey} resolves exactly all eighteen active capabilities`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot(roleKey)
    );

    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.isAdmin, false);
    assert.deepEqual(
      [...resolved.resolvedCapabilities],
      [...ACTIVE_TEAM_CAPABILITY_KEYS]
    );
    assert.deepEqual(resolved.diagnostics, []);
  });
}

test("a future active non-admin role resolves only its explicit grants", () => {
  const roleKey = "future_custom_role";
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot(roleKey, {
      roles: [...roles, { key: roleKey, isActive: true }],
      grants: [
        {
          roleKey,
          capabilityKey: "users.directory.basic.view",
        },
      ],
    })
  );

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.roleKey, roleKey);
  assert.equal(resolved.isAdmin, false);
  assert.deepEqual(resolved.resolvedCapabilities, [
    "users.directory.basic.view",
  ]);
});

test("a session without team membership receives no capabilities", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot(null)
  );

  assert.equal(resolved.status, "not_team_member");
  assert.equal(resolved.isAdmin, false);
  assert.deepEqual(resolved.resolvedCapabilities, []);
});

test("unknown and legacy roles fail closed without admin normalization", () => {
  for (const roleKey of ["unknown_role", "mod", "ADMIN"]) {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot(roleKey)
    );

    assert.equal(resolved.status, "unknown_role");
    assert.equal(resolved.isAdmin, false);
    assert.deepEqual(resolved.resolvedCapabilities, []);
  }
});

test("an inactive role receives no capabilities", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("moderator", {
      roles: roles.map((role) =>
        role.key === "moderator"
          ? { ...role, isActive: false }
          : role
      ),
    })
  );

  assert.equal(resolved.status, "inactive_role");
  assert.deepEqual(resolved.resolvedCapabilities, []);
});

test("a missing grant denies exactly that capability without static fallback", () => {
  const deniedKey = "users.flag.create";
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("moderator", {
      grants: grants.filter(
        (grant) =>
          !(
            grant.roleKey === "moderator" &&
            grant.capabilityKey === deniedKey
          )
      ),
    })
  );

  assert.equal(resolved.status, "resolved");
  assert.deepEqual(
    resolved.resolvedCapabilities,
    ACTIVE_TEAM_CAPABILITY_KEYS.filter((key) => key !== deniedKey)
  );
  assert.deepEqual(
    resolved.diagnostics.map((entry) => entry.code),
    ["grant_missing"]
  );
});

test("no grants means no dynamic rights even for a statically privileged role", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("super_moderator", { grants: [] })
  );

  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.resolvedCapabilities, []);
  assert.equal(
    resolved.diagnostics.filter(
      (entry) => entry.code === "grant_missing"
    ).length,
    ACTIVE_TEAM_CAPABILITY_KEYS.length
  );
});

for (const [name, property, value, code] of [
  [
    "inactive catalog entry",
    "isActive",
    false,
    "catalog_entry_inactive",
  ],
  [
    "non-assignable catalog entry",
    "assignableToNonAdmin",
    false,
    "capability_not_assignable",
  ],
]) {
  test(`${name} denies only the affected capability`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot("trial_moderator", {
        catalog: catalog.map((entry) =>
          entry.key === "users.flag.create"
            ? { ...entry, [property]: value }
            : entry
        ),
      })
    );

    assert.equal(
      resolved.resolvedCapabilities.includes("users.flag.create"),
      false
    );
    assert.equal(
      resolved.diagnostics.some(
        (entry) =>
          entry.code === code &&
          entry.capabilityKey === "users.flag.create"
      ),
      true
    );
  });
}

test("a safe unknown database tombstone is ignored without registry drift", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("trial_moderator", {
      catalog: [
        ...catalog,
        {
          key: "users.unknown",
          isActive: false,
          assignableToNonAdmin: false,
          implementationVersion: 1,
          definitionHash: "0".repeat(64),
        },
      ],
      grants: grants.filter(
        (grant) =>
          grant.roleKey !== "trial_moderator" ||
          grant.capabilityKey === "users.directory.basic.view"
      ),
    })
  );

  assert.equal(resolved.status, "resolved");
  assert.deepEqual(
    resolved.resolvedCapabilities,
    ["users.directory.basic.view"]
  );
  assert.equal(
    resolved.diagnostics.length,
    ACTIVE_TEAM_CAPABILITY_KEYS.length - 1
  );
  assert.equal(
    resolved.diagnostics.every(
      (entry) => entry.code === "grant_missing"
    ),
    true
  );
  assert.equal(
    resolved.diagnostics.some((entry) => entry.kind === "drift"),
    false
  );

  const navigation = resolveTeamAreaNavigation({
    role: resolved.roleKey,
    isAdmin: resolved.isAdmin,
    resolvedCapabilities: resolved.resolvedCapabilities,
  });
  const account = createAccountNavigationState({
    sessionStatus: "authenticated",
    hasVisibleTeamAreaItems: navigation.length > 0,
  });
  assert.equal(JSON.stringify(navigation).includes("users.unknown"), false);
  assert.deepEqual(
    navigation.flatMap((category) =>
      category.items.map((entry) => entry.id)
    ),
    ["user-logs"]
  );
  assert.equal(
    account.items.some((entry) => entry.id === "team_area"),
    true
  );
});

test("new active registry and catalog pairs with zero grants never authorize or drift", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("trial_moderator", {
      grants: grants.filter(
        (grant) => grant.roleKey !== "trial_moderator"
      ),
    })
  );

  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.resolvedCapabilities, []);
  assert.equal(
    resolved.diagnostics.some((entry) => entry.kind === "drift"),
    false
  );
  for (const key of newlyActivatedKeys) {
    assert.equal(resolved.resolvedCapabilities.includes(key), false);
  }
});

for (const [name, catalogOverrides, extraGrant, expectedCode] of [
  ["active", { isActive: true }, null, "unknown_catalog_key_active"],
  [
    "assignable",
    { assignableToNonAdmin: true },
    null,
    "unknown_catalog_key_assignable",
  ],
  [
    "granted to a built-in role",
    {},
    { roleKey: "moderator", capabilityKey: "users.unknown" },
    "unknown_catalog_key_granted",
  ],
  [
    "granted to an unused custom role",
    {},
    { roleKey: "unused_custom_role", capabilityKey: "users.unknown" },
    "unknown_catalog_key_granted",
  ],
  [
    "granted to an inactive role",
    {},
    { roleKey: "inactive_custom_role", capabilityKey: "users.unknown" },
    "unknown_catalog_key_granted",
  ],
]) {
  test(`an unknown database key that is ${name} is registry drift`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot("moderator", {
        catalog: [
          ...catalog,
          {
            key: "users.unknown",
            isActive: false,
            assignableToNonAdmin: false,
            implementationVersion: 1,
            definitionHash: "0".repeat(64),
            ...catalogOverrides,
          },
        ],
        grants: extraGrant ? [...grants, extraGrant] : grants,
      })
    );

    assert.equal(resolved.status, "registry_drift");
    assert.equal(
      resolved.diagnostics.some(
        (entry) =>
          entry.code === expectedCode &&
          entry.capabilityKey === "users.unknown"
      ),
      true
    );
  });
}

test("a missing catalog entry is denied and reported as drift", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("moderator", {
      catalog: catalog.filter(
        (entry) => entry.key !== "users.flag.create"
      ),
    })
  );

  assert.equal(resolved.status, "registry_drift");
  assert.equal(
    resolved.resolvedCapabilities.includes("users.flag.create"),
    false
  );
  assert.equal(
    resolved.diagnostics.some(
      (entry) => entry.code === "active_registry_key_missing_catalog"
    ),
    true
  );
});

for (const [name, property, value, code] of [
  [
    "definition hash drift",
    "definitionHash",
    "f".repeat(64),
    "definition_hash_mismatch",
  ],
  [
    "implementation version drift",
    "implementationVersion",
    3,
    "implementation_version_mismatch",
  ],
]) {
  test(`${name} denies the affected capability`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot("super_moderator", {
        catalog: catalog.map((entry) =>
          entry.key === "users.flag.create"
            ? { ...entry, [property]: value }
            : entry
        ),
      })
    );

    assert.equal(resolved.status, "registry_drift");
    assert.equal(
      resolved.resolvedCapabilities.includes("users.flag.create"),
      false
    );
    assert.equal(
      resolved.diagnostics.some(
        (entry) => entry.code === code
      ),
      true
    );
  });
}

test("dependency failures return one controlled unavailable result", async () => {
  const resolved =
    await resolveDynamicTeamAuthorizationWithLoader(async () => {
      throw new Error("sensitive dependency detail");
    });

  assert.equal(resolved.status, "dependency_unavailable");
  assert.equal(resolved.roleKey, null);
  assert.equal(resolved.isAdmin, false);
  assert.deepEqual(resolved.resolvedCapabilities, []);
  assert.deepEqual(
    resolved.diagnostics.map((entry) => entry.code),
    ["dependency_unavailable"]
  );
  assert.equal(
    JSON.stringify(resolved).includes(
      "sensitive dependency detail"
    ),
    false
  );
});
