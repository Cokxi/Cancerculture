import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDynamicTeamAuthorizationSnapshot,
} from "../../lib/auth/dynamicTeamAuthorization.ts";
import {
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
  isActive: true,
  assignableToNonAdmin: true,
  implementationVersion:
    TEAM_CAPABILITY_REGISTRY[key].implementationVersion,
  definitionHash:
    TEAM_CAPABILITY_REGISTRY[key].definitionHash,
}));
const grants = nonAdminRoles.flatMap((roleKey) =>
  REGISTERED_TEAM_CAPABILITY_KEYS.map((capabilityKey) => ({
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
  test(`${roleKey} matches all three connected static capabilities`, () => {
    const shadow = compareTeamAuthorizationShadow(
      resolve(roleKey)
    );

    assert.equal(shadow.isMatch, true);
    assert.equal(shadow.comparisons.length, 3);
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
            grant.capabilityKey === "users.flag"
          )
      ),
    })
  );

  assert.equal(shadow.isMatch, false);
  assert.deepEqual(shadow.mismatches, [
    {
      roleKey: "moderator",
      capabilityKey: "users.flag",
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
        entry.key === "users.flag"
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

test("an unknown role fails closed even when both value sets are false", () => {
  const shadow = compareTeamAuthorizationShadow(
    resolve("unknown_role")
  );

  assert.equal(shadow.isMatch, false);
  assert.equal(shadow.dynamicStatus, "unknown_role");
  assert.equal(shadow.mismatches.length, 3);
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

test("reserved voting capabilities are absent from the shadow contract", () => {
  assert.deepEqual(
    CONNECTED_TEAM_CAPABILITY_SHADOW_MAP.map(
      (entry) => entry.capabilityKey
    ),
    REGISTERED_TEAM_CAPABILITY_KEYS
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
