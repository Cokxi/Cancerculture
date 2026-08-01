import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath = new URL(
  "../../supabase/migrations/20260801000500_delegable_avatar_upload_logs_capability.sql",
  import.meta.url
);
const migration = await readFile(migrationPath, "utf8");
const definition =
  TEAM_CAPABILITY_REGISTRY["logs.avatar_uploads.view"];

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

test("avatar upload logs capability migration is additive and starts ungranted", () => {
  assert.match(
    migration,
    /AVATAR_UPLOAD_LOG_CAPABILITY_BASELINE_MISMATCH/u
  );
  assert.match(
    migration,
    /AVATAR_UPLOAD_LOG_CAPABILITY_MUST_START_UNGRANTED/u
  );
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'logs\.avatar_uploads\.view'/u);
  assert.match(
    migration,
    /count\(\*\) from public\.capability_catalog\) <> 18/u
  );
  assert.match(migration, /AVATAR_UPLOAD_LOG_TABLE_CONTRACT_MISMATCH/u);
  assert.doesNotMatch(
    migration,
    /delete\s+from|drop\s+(?:table|column|function)/iu
  );
});

test("migration and registry share the exact redacted avatar-log contract", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "d9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813"
  );
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(migration, /avatar object keys/u);
  assert.match(migration, /Changing avatars, cooldowns/u);
});
