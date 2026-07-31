import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
  getRegisteredTeamCapability,
  isRegisteredTeamCapabilityKey,
} from "../../lib/auth/teamCapabilityRegistry.ts";

const expectedActiveKeys = [
  "submissions.submission_phase.moderate",
  "users.flag",
  "users.directory.basic.view",
];
const expectedStagedKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
];
const expectedKeys = [
  "submissions.submission_phase.moderate",
  ...expectedStagedKeys,
  "users.flag",
  "users.directory.basic.view",
];

function canonicalDefinition(definition) {
  return {
    key: definition.key,
    display_name: definition.displayName,
    description: definition.description,
    category: definition.category,
    included_actions: definition.includedActions,
    excluded_actions: definition.excludedActions,
    risk_level: definition.riskLevel,
    assignable_to_non_admin:
      definition.assignableToNonAdmin,
    implementation_version:
      definition.implementationVersion,
  };
}

test("the server registry contains exactly three active and four staged capability keys", () => {
  assert.deepEqual(
    [...REGISTERED_TEAM_CAPABILITY_KEYS],
    expectedKeys
  );
  assert.equal(new Set(expectedKeys).size, expectedKeys.length);
  assert.deepEqual(
    Object.keys(TEAM_CAPABILITY_REGISTRY),
    expectedKeys
  );
  assert.deepEqual(
    [...ACTIVE_TEAM_CAPABILITY_KEYS],
    expectedActiveKeys
  );
  assert.deepEqual(
    expectedKeys.filter(
      (key) => TEAM_CAPABILITY_REGISTRY[key].lifecycle === "staged"
    ),
    expectedStagedKeys
  );
  assert.equal(expectedKeys.includes("users.flag.create"), false);
  assert.equal(expectedKeys.includes("votes.refund_disqualified"), false);
});

test("registry metadata is complete and hashes match canonical definitions", () => {
  const expectedHashes = {
    "submissions.submission_phase.moderate":
      "89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116",
    "submissions.submission_phase.disqualify":
      "c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0",
    "submissions.submission_phase.reinstate":
      "a6c71a89139e91598e94ef77bd3951fd07f06d45ce76d7af0e2dd537c37ef889",
    "submissions.voting_phase.disqualify":
      "0a502187ae8a63f322119c19f8c880bc745902e110afae1b8d4a46388b8f3275",
    "submissions.voting_phase.reinstate":
      "01733447007f7df2532c87a9ecd19042a1d02a687123cebd4bf57f2a7df976fe",
    "users.flag":
      "802eb6c05cdeb7721a068262675b740f3208609eb0355632da09f607f5ec676b",
    "users.directory.basic.view":
      "5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48",
  };

  for (const key of expectedKeys) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(
        JSON.stringify(canonicalDefinition(definition)),
        "utf8"
      )
      .digest("hex");

    assert.equal(definition.key, key);
    assert.ok(definition.displayName.length > 0);
    assert.ok(definition.description.length > 0);
    assert.ok(definition.category.length > 0);
    assert.ok(definition.includedActions.length > 0);
    assert.ok(definition.excludedActions.length > 0);
    const staged = expectedStagedKeys.includes(key);
    assert.equal(definition.assignableToNonAdmin, !staged);
    assert.equal(definition.lifecycle, staged ? "staged" : "active");
    assert.equal(definition.implementationVersion, 1);
    assert.equal(definition.definitionHash, expectedHashes[key]);
    assert.equal(hash, expectedHashes[key]);
  }
});

test("unknown keys fail closed and cannot be synthesized", () => {
  for (const value of [
    "users.unknown",
    "users.*",
    "canFlagUsers",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isRegisteredTeamCapabilityKey(value), false);
    assert.equal(getRegisteredTeamCapability(value), null);
  }
});

test("the registry and every nested definition are runtime immutable", () => {
  assert.equal(Object.isFrozen(TEAM_CAPABILITY_REGISTRY), true);
  assert.equal(
    Object.isFrozen(REGISTERED_TEAM_CAPABILITY_KEYS),
    true
  );

  for (const definition of Object.values(
    TEAM_CAPABILITY_REGISTRY
  )) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.includedActions), true);
    assert.equal(Object.isFrozen(definition.excludedActions), true);
  }

  assert.throws(() => {
    TEAM_CAPABILITY_REGISTRY["users.flag"].displayName =
      "Changed";
  }, TypeError);
  assert.throws(() => {
    TEAM_CAPABILITY_REGISTRY["users.flag"].includedActions.push(
      "Changed"
    );
  }, TypeError);
});
