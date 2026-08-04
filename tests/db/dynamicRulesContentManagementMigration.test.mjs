import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260804000100_dynamic_rules_content_management.sql",
    repoRoot
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

test("the migration is additive, guarded, and registers the exact Rules capability", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["rules.manage"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /RULES_CONTENT_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(migration, /RULES_CONTENT_TARGET_ALREADY_PRESENT/u);
  assert.equal(hash, definition.definitionHash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(
    migration,
    /insert into public\.capability_catalog[\s\S]*'rules\.manage'/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("content state, immutable revisions, publications, and requests are server-only", () => {
  for (const table of [
    "content_documents",
    "content_revisions",
    "content_publications",
    "content_management_requests",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "u")
    );
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table}`, "u")
    );
  }

  assert.match(migration, /content_revisions_append_only/u);
  assert.match(migration, /content_publications_append_only/u);
  assert.match(migration, /content_management_requests_append_only/u);
  assert.match(migration, /CONTENT_HISTORY_APPEND_ONLY/u);
  assert.match(
    migration,
    /grant select on table public\.content_documents to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant (?:insert|update|delete|all)[^;]*content_(?:documents|revisions|publications|management_requests)[^;]*service_role/iu
  );
});

test("the bootstrap preserves the current acceptance version while seeding current text", () => {
  assert.match(migration, /perform public\.assert_rules_content_payload\(v_content\)/u);
  assert.match(
    migration,
    /select current_version[\s\S]*into v_rules_version[\s\S]*from public\.rules_meta/u
  );
  assert.match(migration, /'bootstrap'/u);
  assert.match(
    migration,
    /v_rules_version,\s*v_rules_version,\s*null,\s*null/u
  );
  assert.match(migration, /"id": "participation"/u);
  assert.match(migration, /"id": "final-note"/u);
});

test("the RPC enforces capability, validation, idempotency, and optimistic concurrency", () => {
  assert.match(
    migration,
    /create or replace function public\.assert_rules_manager\(\s*p_actor_discord_user_id text/u
  );
  assert.match(
    migration,
    /capability_key = 'rules\.manage'/u
  );
  assert.match(
    migration,
    /create or replace function public\.manage_rules_content\(/u
  );
  assert.match(migration, /security definer/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /RULES_CONTENT_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /RULES_CONTENT_STATE_CONFLICT/u);
  assert.match(migration, /for update/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /extensions\.digest/u);
  assert.match(
    migration,
    /grant execute on function public\.manage_rules_content[\s\S]*to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.manage_rules_content[\s\S]*to (?:anon|authenticated)/u
  );
});

test("publishing atomically couples structural/material decisions to rules_meta and audit", () => {
  assert.match(
    migration,
    /v_structure_changed := v_published_ids is distinct from v_draft_ids/u
  );
  assert.match(
    migration,
    /v_effective_material_change :=\s*p_material_change or v_structure_changed/u
  );
  assert.match(
    migration,
    /if v_effective_material_change then[\s\S]*update public\.rules_meta[\s\S]*current_version = current_version \+ 1/u
  );
  assert.match(
    migration,
    /insert into public\.content_publications/u
  );
  assert.match(migration, /'rules_published'/u);
  assert.match(migration, /'rules_draft_saved'/u);
  assert.match(
    migration,
    /insert into public\.content_management_requests/u
  );
});

test("postflight checks catalog totals, zero initial grants, ACLs, and function ownership", () => {
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 26/u);
  assert.match(migration, /where capability_key = 'rules\.manage'/u);
  assert.match(migration, /RULES_CONTENT_DATA_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /RULES_CONTENT_SECURITY_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /pg_get_userbyid\(function_row\.proowner\) <> 'postgres'/u);
  assert.match(migration, /function_row\.proconfig is distinct from/u);
  assert.match(migration, /not relation_row\.relrowsecurity/u);
});
