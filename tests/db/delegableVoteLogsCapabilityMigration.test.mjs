import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260801000600_delegable_vote_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition = TEAM_CAPABILITY_REGISTRY["logs.votes.view"];

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

test("vote logs capability migration is bounded and starts ungranted", () => {
  assert.match(migration, /VOTE_LOG_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(migration, /VOTE_LOG_CAPABILITY_MUST_START_UNGRANTED/u);
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'logs\.votes\.view'/u);
  assert.match(
    migration,
    /count\(\*\) from public\.capability_catalog\) <> 19/u
  );
  assert.match(migration, /VOTE_LOG_TABLE_CONTRACT_MISMATCH/u);
  assert.match(
    migration,
    /alter column cycle_id drop not null/u
  );
  assert.doesNotMatch(
    migration,
    /delete\s+from|drop\s+(?:table|column|function)/iu
  );
});

test("migration and registry share the exact redacted vote-log contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /vote-cluster, network, device/u);
  assert.match(migration, /Casting, changing, refunding/u);
});
