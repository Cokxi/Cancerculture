import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDynamicTeamAuthorizationSnapshot,
  resolveDynamicTeamAuthorizationWithLoader,
} from "../../lib/auth/dynamicTeamAuthorization.ts";
import {
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} from "../../lib/auth/teamCapabilityRegistry.ts";

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
    isActive: true,
    assignableToNonAdmin: true,
    implementationVersion: definition.implementationVersion,
    definitionHash: definition.definitionHash,
  };
});
const grants = nonAdminRoles.flatMap((roleKey) =>
  REGISTERED_TEAM_CAPABILITY_KEYS.map((capabilityKey) => ({
    roleKey,
    capabilityKey,
  }))
);

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
  test(`${roleKey} resolves exactly the three registered capabilities`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot(roleKey)
    );

    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.isAdmin, false);
    assert.deepEqual(
      [...resolved.resolvedCapabilities],
      [...REGISTERED_TEAM_CAPABILITY_KEYS]
    );
    assert.deepEqual(resolved.diagnostics, []);
  });
}

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
  const deniedKey = "users.flag";
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
  assert.deepEqual(resolved.resolvedCapabilities, [
    "submissions.submission_phase.moderate",
    "users.directory.basic.view",
  ]);
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
    3
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
          entry.key === "users.flag"
            ? { ...entry, [property]: value }
            : entry
        ),
      })
    );

    assert.equal(
      resolved.resolvedCapabilities.includes("users.flag"),
      false
    );
    assert.equal(
      resolved.diagnostics.some(
        (entry) =>
          entry.code === code &&
          entry.capabilityKey === "users.flag"
      ),
      true
    );
  });
}

test("an unknown database key is ignored and reported as registry drift", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("moderator", {
      catalog: [
        ...catalog,
        {
          key: "users.unknown",
          isActive: true,
          assignableToNonAdmin: true,
          implementationVersion: 1,
          definitionHash: "0".repeat(64),
        },
      ],
      grants: [
        ...grants,
        {
          roleKey: "moderator",
          capabilityKey: "users.unknown",
        },
      ],
    })
  );

  assert.equal(resolved.status, "registry_drift");
  assert.deepEqual(
    resolved.resolvedCapabilities,
    REGISTERED_TEAM_CAPABILITY_KEYS
  );
  assert.equal(
    resolved.diagnostics.some(
      (entry) =>
        entry.code === "unknown_database_capability" &&
        entry.capabilityKey === "users.unknown"
    ),
    true
  );
});

test("a missing catalog entry is denied and reported as drift", () => {
  const resolved = resolveDynamicTeamAuthorizationSnapshot(
    snapshot("moderator", {
      catalog: catalog.filter(
        (entry) => entry.key !== "users.flag"
      ),
    })
  );

  assert.equal(resolved.status, "registry_drift");
  assert.equal(
    resolved.resolvedCapabilities.includes("users.flag"),
    false
  );
  assert.equal(
    resolved.diagnostics.some(
      (entry) => entry.code === "catalog_entry_missing"
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
    2,
    "implementation_version_mismatch",
  ],
]) {
  test(`${name} denies the affected capability`, () => {
    const resolved = resolveDynamicTeamAuthorizationSnapshot(
      snapshot("super_moderator", {
        catalog: catalog.map((entry) =>
          entry.key === "users.flag"
            ? { ...entry, [property]: value }
            : entry
        ),
      })
    );

    assert.equal(resolved.status, "registry_drift");
    assert.equal(
      resolved.resolvedCapabilities.includes("users.flag"),
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
