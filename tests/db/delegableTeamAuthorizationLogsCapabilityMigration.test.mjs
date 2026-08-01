import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260801000800_delegable_team_authorization_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition =
  TEAM_CAPABILITY_REGISTRY["logs.team_authorization.view"];

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

test("team authorization log capability migration is additive and starts ungranted", () => {
  assert.match(
    migration,
    /TEAM_AUTHORIZATION_LOG_CAPABILITY_BASELINE_MISMATCH/u
  );
  assert.match(
    migration,
    /TEAM_AUTHORIZATION_LOG_CAPABILITY_MUST_START_UNGRANTED/u
  );
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'logs\.team_authorization\.view'/u);
  assert.match(
    migration,
    /count\(\*\) from public\.capability_catalog\) <> 21/u
  );
  assert.match(
    migration,
    /create index team_authorization_audit_event_occurred_idx[\s\S]*event_type[\s\S]*occurred_at desc[\s\S]*id desc/u
  );
  assert.doesNotMatch(
    migration,
    /delete\s+from|update\s+public\.team_authorization_audit|drop\s+(?:table|column|function)/iu
  );
});

test("migration and registry share the exact redacted team-authorization contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "69faf8e792eb9ee98366d3be382d6020ba46994b514c07c3ab2e970c716be1ba"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /raw before\/after objects/u);
  assert.match(migration, /Roles & Permissions matrix/u);
});

test("migration preserves the append-only audit boundary and browser ACLs", () => {
  assert.match(migration, /relrowsecurity/u);
  assert.match(migration, /protect_team_authorization_audit/u);
  assert.match(
    migration,
    /has_table_privilege\('anon', 'public\.team_authorization_audit', 'select'\)/u
  );
  assert.match(
    migration,
    /has_table_privilege\('authenticated', 'public\.team_authorization_audit', 'select'\)/u
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete).*team_authorization_audit/iu
  );
});
