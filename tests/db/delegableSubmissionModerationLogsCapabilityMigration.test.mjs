import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260801000700_delegable_submission_moderation_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition =
  TEAM_CAPABILITY_REGISTRY["logs.submission_moderation.view"];

function canonicalDefinition(entry) {
  return {
    key: entry.key,
    display_name: entry.displayName,
    description: entry.description,
    category: entry.category,
    included_actions: entry.includedActions,
    excluded_actions: entry.excludedActions,
    risk_level: entry.riskLevel,
    assignable_to_non_admin: entry.assignableToNonAdmin,
    implementation_version: entry.implementationVersion,
  };
}

test("submission moderation log capability migration is additive and starts ungranted", () => {
  assert.match(
    migration,
    /SUBMISSION_MODERATION_LOG_CAPABILITY_BASELINE_MISMATCH/u
  );
  assert.match(
    migration,
    /SUBMISSION_MODERATION_LOG_CAPABILITY_MUST_START_UNGRANTED/u
  );
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'logs\.submission_moderation\.view'/u);
  assert.match(
    migration,
    /count\(\*\) from public\.capability_catalog\) <> 20/u
  );
  assert.match(
    migration,
    /SUBMISSION_MODERATION_LOG_TABLE_CONTRACT_MISMATCH/u
  );
  assert.doesNotMatch(
    migration,
    /delete\s+from|update\s+public\.moderation_action_logs|drop\s+(?:table|column|function)/iu
  );
});

test("migration and registry share the exact redacted moderation-log contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /free-text moderation notes, exact reason codes/u);
  assert.match(migration, /Disqualifying, reinstating, hiding/u);
});
