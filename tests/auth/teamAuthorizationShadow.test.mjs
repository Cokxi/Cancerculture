import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDynamicTeamAuthorizationSnapshot,
} from "../../lib/auth/dynamicTeamAuthorization.ts";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} from "../../lib/auth/teamCapabilityRegistry.ts";
import {
  CONNECTED_TEAM_CAPABILITY_SHADOW_MAP,
  compareTeamAuthorizationShadow,
} from "../../lib/auth/teamAuthorizationShadow.ts";

const nonAdminRoles = [
  "trial_moderator",
  "moderator",
  "super_moderator",
];
const roles = [
  { key: "admin", isActive: true },
  ...nonAdminRoles.map((key) => ({ key, isActive: true })),
];
const catalog = REGISTERED_TEAM_CAPABILITY_KEYS.map((key) => ({
  key,
  isActive: TEAM_CAPABILITY_REGISTRY[key].lifecycle === "active",
  assignableToNonAdmin:
    TEAM_CAPABILITY_REGISTRY[key].lifecycle === "active",
  implementationVersion:
    TEAM_CAPABILITY_REGISTRY[key].implementationVersion,
  definitionHash:
    TEAM_CAPABILITY_REGISTRY[key].definitionHash,
}));
const grants = nonAdminRoles.flatMap((roleKey) =>
  ACTIVE_TEAM_CAPABILITY_KEYS.map((capabilityKey) => ({
    roleKey,
    capabilityKey,
  }))
);

function resolve(roleKey, overrides = {}) {
  return resolveDynamicTeamAuthorizationSnapshot({
    teamMemberRoleKey: roleKey,
    roles,
    catalog,
    grants,
    ...overrides,
  });
}

for (const roleKey of nonAdminRoles) {
test(`${roleKey} matches the remaining connected static capability`, () => {
    const shadow = compareTeamAuthorizationShadow(
      resolve(roleKey)
    );

    assert.equal(shadow.isMatch, true);
    assert.equal(shadow.comparisons.length, 1);
    assert.equal(
      shadow.comparisons.every(
        (comparison) =>
          comparison.staticValue &&
          comparison.dynamicValue &&
          comparison.matches
      ),
      true
    );
    assert.deepEqual(shadow.mismatches, []);
  });
}

test("admin matches through the hard owner context without grant rows", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("admin", { catalog: [], grants: [] })
  );

  assert.equal(shadow.isMatch, true);
  assert.equal(
    shadow.comparisons.every(
      (comparison) =>
        comparison.staticValue &&
        comparison.dynamicValue &&
        comparison.matches
    ),
    true
  );
});

test("a missing grant produces one structured mismatch", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("moderator", {
      grants: grants.filter(
        (grant) =>
          !(
            grant.roleKey === "moderator" &&
            grant.capabilityKey === "users.directory.basic.view"
          )
      ),
    })
  );

  assert.equal(shadow.isMatch, false);
  assert.deepEqual(shadow.mismatches, [
    {
      roleKey: "moderator",
      capabilityKey: "users.directory.basic.view",
      staticValue: true,
      dynamicValue: false,
      reasonCode: "grant_missing",
      reason:
        "No positive grant exists for the role and capability.",
    },
  ]);
});

test("definition drift produces an explicit affected-capability mismatch", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("super_moderator", {
      catalog: catalog.map((entry) =>
        entry.key === "users.directory.basic.view"
          ? { ...entry, definitionHash: "0".repeat(64) }
          : entry
      ),
    })
  );

  assert.equal(shadow.isMatch, false);
  assert.equal(shadow.dynamicStatus, "registry_drift");
  assert.equal(shadow.mismatches.length, 1);
  assert.equal(
    shadow.mismatches[0].reasonCode,
    "definition_hash_mismatch"
  );
});

test("shadow comparison ignores a safe tombstone and retains dangerous drift", () => {
  const tombstone = {
    key: "test.compatibility.tombstone",
    isActive: false,
    assignableToNonAdmin: false,
    implementationVersion: 1,
    definitionHash: "0".repeat(64),
  };
  const safe = compareTeamAuthorizationShadow(
    resolve("moderator", { catalog: [...catalog, tombstone] })
  );
  const dangerous = compareTeamAuthorizationShadow(
    resolve("moderator", {
      catalog: [...catalog, { ...tombstone, isActive: true }],
    })
  );

  assert.equal(safe.dynamicStatus, "resolved");
  assert.equal(safe.isMatch, true);
  assert.equal(dangerous.dynamicStatus, "registry_drift");
  assert.equal(dangerous.isMatch, false);
});

test("an unknown role fails closed even when both value sets are false", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("unknown_role")
  );

  assert.equal(shadow.isMatch, false);
  assert.equal(shadow.dynamicStatus, "unknown_role");
  assert.equal(shadow.mismatches.length, 1);
  assert.equal(
    shadow.mismatches.every(
      (mismatch) =>
        !mismatch.staticValue &&
        !mismatch.dynamicValue &&
        mismatch.reasonCode === "role_not_registered"
    ),
    true
  );
});

test("granular moderation capabilities remain absent from the static shadow contract", () => {
  assert.deepEqual(
    CONNECTED_TEAM_CAPABILITY_SHADOW_MAP.map(
      (entry) => entry.capabilityKey
    ),
    ["users.directory.basic.view"]
  );

  const serialized = JSON.stringify(
    CONNECTED_TEAM_CAPABILITY_SHADOW_MAP
  );

  for (const capability of [
    "canDisqualifyDuringVoting",
    "canReinstateDuringVoting",
    "canRefundDisqualifiedVotes",
  ]) {
    assert.equal(serialized.includes(capability), false);
  }
});

test("new active zero-grant capabilities create no shadow mismatch", () => {
  const roleKey = "future_custom_role";
  const shadow = compareTeamAuthorizationShadow(
    resolve(roleKey, {
      roles: [...roles, { key: roleKey, isActive: true }],
      grants: [],
    })
  );

  assert.equal(shadow.dynamicStatus, "resolved");
  assert.equal(shadow.isMatch, true);
  assert.deepEqual(shadow.mismatches, []);
});

test("shadow mismatch objects expose no person or session fields", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("moderator", { grants: [] })
  );
  const forbiddenKeys = new Set([
    "discordUserId",
    "discord_user_id",
    "userId",
    "user_id",
    "sessionId",
    "session_id",
  ]);

  function inspect(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false);
      inspect(child);
    }
  }

  inspect(shadow);
});
