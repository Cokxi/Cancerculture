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
    "supabase/migrations/20260731000300_stage_submission_capabilities.sql",
    repoRoot
  ),
  "utf8"
);
const registry = await readFile(
  new URL("lib/auth/teamCapabilityRegistry.ts", repoRoot),
  "utf8"
);

const definitions = [
  {
    key: "submissions.submission_phase.disqualify",
    display_name: "Disqualify Submission-Phase Submissions",
    description:
      "Disqualify a submission only during the currently permitted submission phase.",
    category: "Submission Moderation",
    included_actions: [
      "Disqualify a submission during the currently allowed submission phase.",
    ],
    excluded_actions: [
      "Reinstating submissions.",
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles and historical repairs.",
    ],
    risk_level: "high",
    assignable_to_non_admin: false,
    implementation_version: 1,
  },
  {
    key: "submissions.submission_phase.reinstate",
    display_name: "Reinstate Submission-Phase Submissions",
    description:
      "Reinstate a previously disqualified submission only during the currently permitted submission phase under the existing moderation policy.",
    category: "Submission Moderation",
    included_actions: [
      "Reinstate a previously disqualified submission during the currently allowed submission phase.",
    ],
    excluded_actions: [
      "Disqualifying submissions.",
      "Voting-phase moderation.",
      "Vote refunds.",
      "Public visibility changes.",
      "Legal review.",
      "Finalized or archived cycles and historical repairs.",
    ],
    risk_level: "high",
    assignable_to_non_admin: false,
    implementation_version: 1,
  },
  {
    key: "submissions.voting_phase.disqualify",
    display_name: "Disqualify Voting-Phase Submissions",
    description:
      "Disqualify a submission only during an open voting phase.",
    category: "Submission Moderation",
    included_actions: [
      "Disqualify a submission during the open voting phase.",
    ],
    excluded_actions: [
      "Reinstating submissions.",
      "Submission-phase moderation.",
      "Vote refunds.",
      "Historical result repairs.",
      "Public visibility changes.",
      "Legal review.",
    ],
    risk_level: "critical",
    assignable_to_non_admin: false,
    implementation_version: 1,
  },
  {
    key: "submissions.voting_phase.reinstate",
    display_name: "Reinstate Voting-Phase Submissions",
    description:
      "Reinstate a previously disqualified submission only during an open voting phase under the voting-phase reinstatement policy.",
    category: "Submission Moderation",
    included_actions: [
      "Reinstate a previously disqualified submission during the open voting phase.",
    ],
    excluded_actions: [
      "Disqualifying submissions.",
      "Submission-phase moderation.",
      "Vote refunds.",
      "Historical result repairs.",
      "Public visibility changes.",
      "Legal review.",
    ],
    risk_level: "critical",
    assignable_to_non_admin: false,
    implementation_version: 1,
  },
];

const expectedHashes = new Map(
  definitions.map((definition) => [
    definition.key,
    createHash("sha256")
      .update(JSON.stringify(definition), "utf8")
      .digest("hex"),
  ])
);

test("the migration stages exactly four additive catalog keys", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /set local statement_timeout = '45s'/u);
  assert.equal(definitions.length, 4);
  assert.equal(new Set(definitions.map(({ key }) => key)).size, 4);

  for (const definition of definitions) {
    assert.match(migration, new RegExp(`'${definition.key}'`, "u"));
    assert.match(
      migration,
      new RegExp(`'${expectedHashes.get(definition.key)}'`, "u")
    );
  }

  for (const forbiddenKey of [
    "users.flag.create",
    "votes.refund_disqualified",
  ]) {
    assert.doesNotMatch(migration, new RegExp(forbiddenKey, "u"));
  }
});

test("every staged definition is final, deterministic and non-authorizing", () => {
  const forbiddenText = /\b(?:todo|placeholder|future capability)\b/iu;

  for (const definition of definitions) {
    assert.equal(definition.assignable_to_non_admin, false);
    assert.equal(definition.implementation_version, 1);
    assert.equal(expectedHashes.get(definition.key)?.length, 64);
    assert.ok(definition.description.length > 0);
    assert.ok(definition.included_actions.length > 0);
    assert.ok(definition.excluded_actions.length >= 5);
    assert.equal(forbiddenText.test(JSON.stringify(definition)), false);
  }

  assert.match(
    migration,
    /assignable_to_non_admin[\s\S]*is_active[\s\S]*values[\s\S]*'c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0'/u
  );
  assert.equal(
    [...migration.matchAll(/\n\s*false,\s*\n\s*false,\s*\n\s*1,/gu)]
      .length,
    4
  );
});

test("conflicts and grants fail closed without overwriting existing rows", () => {
  assert.match(migration, /STAGED_SUBMISSION_CAPABILITY_CONFLICT/u);
  assert.match(
    migration,
    /STAGED_SUBMISSION_CAPABILITY_ALREADY_GRANTED/u
  );
  assert.match(
    migration,
    /STAGED_SUBMISSION_CAPABILITY_POSTFLIGHT_FAILED/u
  );
  assert.match(
    migration,
    /STAGED_SUBMISSION_CAPABILITY_GRANT_POSTFLIGHT_FAILED/u
  );
  assert.doesNotMatch(
    migration,
    /on conflict[\s\S]*do update|update\s+public\.capability_catalog|delete\s+from\s+public\.capability_catalog/iu
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("the legacy moderation capability and every security boundary stay unchanged", () => {
  assert.match(
    migration,
    /LEGACY_SUBMISSION_MODERATION_CAPABILITY_DRIFT/u
  );
  assert.match(
    migration,
    /'submissions\.submission_phase\.moderate'[\s\S]*'89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116'/u
  );
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
});

test("the immutable staged definitions remain predecessors within the later flag registry", () => {
  for (const definition of definitions) {
    const registered = TEAM_CAPABILITY_REGISTRY[definition.key];
    assert.ok(registered);
    assert.deepEqual(
      {
        key: registered.key,
        display_name: registered.displayName,
        description: registered.description,
        category: registered.category,
        included_actions: [...registered.includedActions],
        excluded_actions: [...registered.excludedActions],
        risk_level: registered.riskLevel,
      },
      {
        key: definition.key,
        display_name: definition.display_name,
        description: definition.description,
        category: definition.category,
        included_actions: definition.included_actions,
        excluded_actions: definition.excluded_actions,
        risk_level: definition.risk_level,
      }
    );
    assert.equal(definition.assignable_to_non_admin, false);
    assert.equal(definition.implementation_version, 1);
    assert.equal(registered.lifecycle, "active");
    assert.equal(registered.assignableToNonAdmin, true);
    assert.equal(registered.implementationVersion, 2);
    assert.notEqual(registered.definitionHash, expectedHashes.get(definition.key));
  }

  const registeredKeysBlock = registry.match(
    /REGISTERED_TEAM_CAPABILITY_KEYS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u
  )?.[1];
  assert.ok(registeredKeysBlock);
  assert.equal(
    [...registeredKeysBlock.matchAll(/"[a-z][a-z0-9_.]+"/gu)].length,
    22
  );
  assert.equal(REGISTERED_TEAM_CAPABILITY_KEYS.length, 22);
  assert.equal(ACTIVE_TEAM_CAPABILITY_KEYS.length, 20);
  assert.match(
    registry,
    /submissions\.submission_phase\.moderate[\s\S]*7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b/u
  );
});
