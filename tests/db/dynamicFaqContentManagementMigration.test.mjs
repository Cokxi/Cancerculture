import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260805000100_dynamic_faq_content_management.sql",
    repoRoot
  ),
  "utf8"
);
const devTransactionTest = await readFile(
  new URL("tests/db/dynamicFaqContentManagement.dev.sql", repoRoot),
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

test("the FAQ migration is additive, guarded, and registers the exact capability", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["faq.manage"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /FAQ_CONTENT_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(migration, /FAQ_CONTENT_TARGET_ALREADY_PRESENT/u);
  assert.equal(hash, definition.definitionHash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.match(
    migration,
    /insert into public\.capability_catalog[\s\S]*'faq\.manage'/u
  );
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("FAQ reuses immutable server-only content history without storing a draft", () => {
  assert.match(
    migration,
    /alter table public\.content_publications[\s\S]*content_publications_document_context_check/u
  );
  assert.match(
    migration,
    /document_key = 'faq'[\s\S]*requested_material_change is null[\s\S]*rules_version is null/u
  );
  assert.match(
    migration,
    /check \(operation in \('save_draft', 'publish', 'save_publish'\)\)/u
  );
  assert.match(migration, /values \('faq', 1\)/u);
  assert.match(migration, /perform public\.assert_faq_content_payload\(v_content\)/u);
  assert.match(migration, /"id": "wallet"/u);
  assert.match(migration, /"id": "rules"/u);
  assert.match(migration, /v_document\.draft_revision_id is not null/u);
  assert.doesNotMatch(
    migration,
    /(?:from|update|insert into|delete from)\s+public\.rules_meta/iu
  );
});

test("the FAQ RPC validates, authorizes, locks, and publishes atomically", () => {
  assert.match(
    migration,
    /create or replace function public\.assert_faq_manager\(\s*p_actor_discord_user_id text/u
  );
  assert.match(migration, /capability_key = 'faq\.manage'/u);
  assert.match(
    migration,
    /create or replace function public\.manage_faq_content\(/u
  );
  assert.match(migration, /security definer/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /FAQ_CONTENT_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /FAQ_CONTENT_STATE_CONFLICT/u);
  assert.match(migration, /FAQ_CONTENT_NO_CHANGES/u);
  assert.match(migration, /for update/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /extensions\.digest/u);
  assert.match(
    migration,
    /set published_revision_id = v_revision_id,[\s\S]*state_version = state_version \+ 1/u
  );
  assert.match(migration, /'faq_published'/u);
  assert.match(migration, /'save_publish'/u);
  assert.match(
    migration,
    /grant execute on function public\.manage_faq_content[\s\S]*to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.manage_faq_content[\s\S]*to (?:anon|authenticated)/u
  );
});

test("FAQ postflight checks zero grants, no draft, ACLs, and function ownership", () => {
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 27/u);
  assert.match(migration, /where capability_key = 'faq\.manage'/u);
  assert.match(migration, /document_row\.draft_revision_id is null/u);
  assert.match(migration, /FAQ_CONTENT_DATA_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /FAQ_CONTENT_SECURITY_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /pg_get_userbyid\(function_row\.proowner\) <> 'postgres'/u);
  assert.match(migration, /function_row\.proconfig is distinct from/u);
  assert.match(migration, /not relation_row\.relrowsecurity/u);
});

test("the rollback-only DEV contract covers replay, conflicts, audit, and Rules isolation", () => {
  assert.match(devTransactionTest, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devTransactionTest, /rollback;\s*$/u);
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_REPLAY_MISMATCH/u);
  assert.match(
    devTransactionTest,
    /DYNAMIC_FAQ_TEST_IDEMPOTENCY_CONFLICT_ACCEPTED/u
  );
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_STALE_REQUEST_ACCEPTED/u);
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_UNCHANGED_CONTENT_ACCEPTED/u);
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_UNAUTHORIZED_REQUEST_ACCEPTED/u);
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_HISTORY_MISMATCH/u);
  assert.match(devTransactionTest, /DYNAMIC_FAQ_TEST_RULES_STATE_CHANGED/u);
});
