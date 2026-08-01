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
  "users.directory.full.view",
  "users.upload_blocks.view",
  "users.website_bans.view",
  "users.website_bans.create",
  "users.website_bans.revoke",
  "logs.website_bans.view",
  "logs.uploads.view",
  "logs.avatar_uploads.view",
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

test("the server registry contains eighteen known and sixteen active capability keys", () => {
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
      "284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b",
    "users.flag.view":
      "20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e",
    "users.flag.review":
      "8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869",
    "users.directory.basic.view":
      "5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48",
    "users.directory.full.view":
      "df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1",
    "users.upload_blocks.view":
      "174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204",
    "users.website_bans.view":
      "4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388",
    "users.website_bans.create":
      "66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470",
    "users.website_bans.revoke":
      "1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706",
    "logs.website_bans.view":
      "a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3",
    "logs.uploads.view":
      "3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b",
    "logs.avatar_uploads.view":
      "d9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813",
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
    const versionTwo =
      deprecated ||
      activatedKeys.includes(key) ||
      key.startsWith("users.flag.") ||
      key === "users.directory.full.view";
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
