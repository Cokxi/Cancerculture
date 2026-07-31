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

const activatedKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
];
const expectedKeys = [
  "submissions.submission_phase.moderate",
  ...activatedKeys,
  "users.flag",
  "users.flag.create",
  "users.flag.view",
  "users.flag.review",
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

test("the server registry contains ten known and eight active capability keys", () => {
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
    expectedKeys.filter(
      (key) =>
        ![
          "submissions.submission_phase.moderate",
          "users.flag",
        ].includes(key)
    )
  );
  assert.deepEqual(
    expectedKeys.filter(
      (key) => TEAM_CAPABILITY_REGISTRY[key].lifecycle === "staged"
    ),
    []
  );
  assert.equal(expectedKeys.includes("users.flag.create"), true);
  assert.equal(expectedKeys.includes("votes.refund_disqualified"), false);
});

test("registry metadata is complete and hashes match canonical definitions", () => {
  const expectedHashes = {
    "submissions.submission_phase.moderate":
      "7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b",
    "submissions.submission_phase.disqualify":
      "3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732",
    "submissions.submission_phase.reinstate":
      "7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2",
    "submissions.voting_phase.disqualify":
      "cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de",
    "submissions.voting_phase.reinstate":
      "4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0",
    "users.flag":
      "4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c",
    "users.flag.create":
      "bf758cdf0fa93e88b27a40582916efbea56d5d25d708d02f9889ed3a3cbe5dbf",
    "users.flag.view":
      "8cbde5054432fc6630bbec66c68ce98393f6c37744eb8452b28ea67dfdbc431c",
    "users.flag.review":
      "d43a7db86453e3432b04b65bad4cb7b01555c77f18cd4c26bd58a626d5508dbe",
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
    const deprecated = [
      "submissions.submission_phase.moderate",
      "users.flag",
    ].includes(key);
    const versionTwo = deprecated || activatedKeys.includes(key);
    assert.equal(definition.assignableToNonAdmin, !deprecated);
    assert.equal(definition.lifecycle, deprecated ? "deprecated" : "active");
    assert.equal(
      definition.implementationVersion,
      versionTwo ? 2 : 1
    );
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
