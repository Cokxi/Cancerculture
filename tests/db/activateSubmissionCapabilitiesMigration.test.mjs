import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260731000400_activate_submission_capabilities.sql",
    repoRoot
  ),
  "utf8"
);

const transitions = [
  {
    key: "submissions.submission_phase.disqualify",
    oldHash:
      "c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0",
    newHash:
      "3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732",
  },
  {
    key: "submissions.submission_phase.reinstate",
    oldHash:
      "a6c71a89139e91598e94ef77bd3951fd07f06d45ce76d7af0e2dd537c37ef889",
    newHash:
      "7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2",
  },
  {
    key: "submissions.voting_phase.disqualify",
    oldHash:
      "0a502187ae8a63f322119c19f8c880bc745902e110afae1b8d4a46388b8f3275",
    newHash:
      "cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de",
  },
  {
    key: "submissions.voting_phase.reinstate",
    oldHash:
      "01733447007f7df2532c87a9ecd19042a1d02a687123cebd4bf57f2a7df976fe",
    newHash:
      "4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0",
  },
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
    assignable_to_non_admin: definition.assignableToNonAdmin,
    implementation_version: definition.implementationVersion,
  };
}

test("the activation migration targets exactly the four staged submission keys", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /set local statement_timeout = '45s'/u);
  assert.equal(transitions.length, 4);
  assert.equal(new Set(transitions.map(({ key }) => key)).size, 4);

  for (const transition of transitions) {
    assert.match(migration, new RegExp(`'${transition.key}'`, "u"));
    assert.match(migration, new RegExp(`'${transition.oldHash}'`, "u"));
    assert.match(migration, new RegExp(`'${transition.newHash}'`, "u"));
  }
  assert.doesNotMatch(migration, /users\.flag\.create/u);
  assert.doesNotMatch(migration, /votes\.refund_disqualified/u);
});

test("assignability changes the canonical definition exactly once", () => {
  for (const transition of transitions) {
    const definition = TEAM_CAPABILITY_REGISTRY[transition.key];
    const computedHash = createHash("sha256")
      .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
      .digest("hex");

    assert.equal(definition.lifecycle, "active");
    assert.equal(definition.assignableToNonAdmin, true);
    assert.equal(definition.implementationVersion, 2);
    assert.equal(definition.definitionHash, transition.newHash);
    assert.equal(computedHash, transition.newHash);
    assert.notEqual(transition.oldHash, transition.newHash);
  }
});

test("preflight accepts only the complete staged or complete final state with zero grants", () => {
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_CATALOG_BASELINE_MISMATCH/u
  );
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_REQUIRES_ZERO_GRANTS/u
  );
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_STATE_DRIFT/u
  );
  assert.match(migration, /staged_count <> 4 and active_count <> 4/u);
  assert.match(migration, /is not distinct from row/iu);
  assert.match(migration, /false,\s*false,/u);
  assert.match(migration, /true,\s*true,/u);
});

test("the update activates and exposes exactly four definitions without grants", () => {
  assert.match(
    migration,
    /update public\.capability_catalog existing[\s\S]*assignable_to_non_admin = true,[\s\S]*is_active = true,[\s\S]*implementation_version = expected\.active_implementation_version,[\s\S]*definition_hash = expected\.active_definition_hash[\s\S]*where expected\.key = existing\.key/u
  );
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_UPDATE_COUNT_MISMATCH/u
  );
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_POSTFLIGHT_FAILED/u
  );
  assert.match(
    migration,
    /SUBMISSION_CAPABILITY_ACTIVATION_TOTALS_MISMATCH/u
  );
  assert.match(
    migration,
    /NON_TARGET_CAPABILITY_CHANGED_DURING_ACTIVATION/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("security, audit, ledger and mutation surfaces remain unchanged", () => {
  assert.doesNotMatch(
    migration,
    /\b(?:grant|revoke)\s+(?:all|select|insert|update|delete|execute|usage)\b/iu
  );
  assert.doesNotMatch(
    migration,
    /create\s+(?:or\s+replace\s+)?(?:function|trigger)|alter\s+function|\brpc\s*\(/iu
  );
  assert.doesNotMatch(
    migration,
    /team_authorization_audit|team_authorization_batches/iu
  );
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+public\.capability_catalog|delete\s+from\s+public\.capability_catalog/iu
  );
});

test("the registry preserves known definitions after later cutovers", () => {
  assert.equal(REGISTERED_TEAM_CAPABILITY_KEYS.length, 57);
  assert.equal(ACTIVE_TEAM_CAPABILITY_KEYS.length, 53);
  assert.equal(
    Object.values(TEAM_CAPABILITY_REGISTRY).filter(
      (definition) => definition.lifecycle === "staged"
    ).length,
    0
  );
  assert.deepEqual(
    [
      TEAM_CAPABILITY_REGISTRY[
        "submissions.submission_phase.moderate"
      ].definitionHash,
      TEAM_CAPABILITY_REGISTRY["users.flag"].definitionHash,
      TEAM_CAPABILITY_REGISTRY["users.directory.basic.view"]
        .definitionHash,
    ],
    [
      "7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b",
      "4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c",
      "5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48",
    ]
  );
  assert.equal(
    TEAM_CAPABILITY_REGISTRY[
      "submissions.submission_phase.moderate"
    ].lifecycle,
    "deprecated"
  );
  assert.equal(TEAM_CAPABILITY_REGISTRY["users.flag"].lifecycle, "deprecated");
  assert.equal(
    TEAM_CAPABILITY_REGISTRY["submissions.reports.assign"].lifecycle,
    "deprecated"
  );
});
