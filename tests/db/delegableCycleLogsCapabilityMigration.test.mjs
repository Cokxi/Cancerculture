import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260802000100_delegable_cycle_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition = TEAM_CAPABILITY_REGISTRY["cycles.logs.view"];

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

test("Cycle Log capability migration is additive and starts ungranted", () => {
  assert.match(migration, /CYCLE_LOG_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'cycles\.logs\.view'/u);
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 22/u);
  assert.match(
    migration,
    /create index admin_action_logs_cycle_created_idx[\s\S]*created_at desc[\s\S]*id desc[\s\S]*where target_type = 'cycle'/u
  );
  assert.doesNotMatch(
    migration,
    /delete\s+from|update\s+public\.admin_action_logs|drop\s+(?:table|column|function)/iu
  );
});

test("migration and registry share the exact safe Cycle Log contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /free-text reset reasons/u);
  assert.match(migration, /Starting, ending, finalizing, resetting/u);
  assert.match(migration, /Managing winners, payouts/u);
});

test("migration preserves RLS and Browser ACL boundaries", () => {
  assert.match(migration, /relrowsecurity/u);
  assert.match(
    migration,
    /has_table_privilege\('anon', 'public\.admin_action_logs', 'select'\)/u
  );
  assert.match(
    migration,
    /has_table_privilege\('authenticated', 'public\.admin_action_logs', 'select'\)/u
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete).*admin_action_logs/iu
  );
});
