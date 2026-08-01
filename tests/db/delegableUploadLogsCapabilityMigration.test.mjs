import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260801000400_delegable_upload_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition = TEAM_CAPABILITY_REGISTRY["logs.uploads.view"];

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

test("upload logs capability migration is additive and starts ungranted", () => {
  assert.match(migration, /UPLOAD_LOG_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(migration, /UPLOAD_LOG_CAPABILITY_MUST_START_UNGRANTED/u);
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'logs\.uploads\.view'/u);
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 17/u);
  assert.doesNotMatch(migration, /delete\s+from|drop\s+(?:table|column|function)/iu);
});

test("migration and registry share the exact redacted capability contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /raw provider, storage, infrastructure/u);
  assert.match(migration, /upload-abuse counters, thresholds/u);
});
