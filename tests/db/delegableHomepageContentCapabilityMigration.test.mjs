import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260805000200_delegable_homepage_content_management.sql",
    root
  ),
  "utf8"
);

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

test("homepage_content.manage is exact, active, high risk, and canonically hashed", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["homepage_content.manage"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.equal(
    hash,
    "b9f5db882c8fa65f235ef2fe83f1cc90515761e21ea885e4ca80e58b2476957a"
  );
  assert.equal(definition.definitionHash, hash);
  assert.equal(definition.riskLevel, "high");
  assert.equal(definition.lifecycle, "active");
  assert.equal(definition.assignableToNonAdmin, true);
  assert.match(migration, new RegExp(hash, "u"));
});

test("the additive migration checks its exact FAQ predecessor and starts with zero grants", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(
    migration,
    /HOMEPAGE_CONTENT_CAPABILITY_BASELINE_MISMATCH/u
  );
  assert.match(
    migration,
    /key = 'faq\.manage'[\s\S]*7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93/u
  );
  assert.match(
    migration,
    /insert into public\.capability_catalog[\s\S]*'homepage_content\.manage'/u
  );
  assert.match(
    migration,
    /where capability_key = 'homepage_content\.manage'[\s\S]*HOMEPAGE_CONTENT_CAPABILITY_POSTFLIGHT_MISMATCH/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("the permission cutover does not alter Homepage Info content or its table contract", () => {
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from|alter\s+table)\s+public\.homepage_info_blocks/iu
  );
  assert.doesNotMatch(
    migration,
    /['"]content\.manage['"]|coin_launches\.manage/iu
  );
});
