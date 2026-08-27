import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTIVE_TEAM_CAPABILITY_KEYS,
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
} from "../../lib/auth/teamCapabilityRegistry.ts";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260827000100_user_overwatch_foundation.sql",
    import.meta.url,
  ),
  "utf8",
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

test("Overwatch capabilities are exact, active, independently delegable, and zero-grant", () => {
  assert.equal(REGISTERED_TEAM_CAPABILITY_KEYS.length, 54);
  assert.equal(ACTIVE_TEAM_CAPABILITY_KEYS.length, 50);
  for (const key of ["users.overwatch.view", "users.overwatch.manage"]) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
      .digest("hex");
    assert.equal(definition.lifecycle, "active");
    assert.equal(definition.assignableToNonAdmin, true);
    assert.equal(definition.implementationVersion, 1);
    assert.equal(definition.definitionHash, hash);
    assert.match(migration, new RegExp(key.replaceAll(".", "\\."), "u"));
    assert.match(migration, new RegExp(hash, "u"));
  }
  assert.match(migration, /capability_catalog\) <> 52/u);
  assert.match(migration, /capability_catalog\) <> 54/u);
  assert.match(migration, /capability_key in \('users\.overwatch\.view', 'users\.overwatch\.manage'\)/u);
  assert.match(migration, /USER_OVERWATCH_UNEXPECTED_GRANT/u);
});

test("Overwatch has a separate generation, current, event, and request domain", () => {
  for (const relation of [
    "user_overwatch_generations",
    "user_overwatch_current",
    "user_overwatch_events",
    "user_overwatch_requests",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${relation}`, "u"));
    assert.match(migration, new RegExp(`alter table public\\.${relation} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${relation}`, "u"));
    assert.doesNotMatch(migration, new RegExp(`create policy[\\s\\S]*${relation}`, "iu"));
  }
  assert.match(migration, /unique \(target_discord_user_id, generation\)/u);
  assert.match(migration, /user_overwatch_one_active_target_idx[\s\S]*where state = 'active'/u);
  assert.match(migration, /event_type text not null check \(event_type in \('added', 'removed'\)\)/u);
  assert.match(migration, /operation text not null check \(operation in \('add', 'remove'\)\)/u);
  assert.match(migration, /USER_OVERWATCH_HISTORY_IS_APPEND_ONLY/u);
  assert.match(migration, /USER_OVERWATCH_CURRENT_TRANSITION_FORBIDDEN/u);
});

test("Overwatch mutations bind state, version, target, reason, request UUID, replay, and concurrency", () => {
  assert.match(migration, /create function public\.add_user_to_overwatch\([\s\S]*p_expected_state text[\s\S]*p_expected_row_version bigint[\s\S]*p_reason text[\s\S]*p_request_id uuid/u);
  assert.match(migration, /create function public\.remove_user_from_overwatch\([\s\S]*p_target_discord_user_id text[\s\S]*p_public_entry_id uuid[\s\S]*p_expected_state text[\s\S]*p_expected_row_version bigint/u);
  assert.match(migration, /user-overwatch-request:/u);
  assert.match(migration, /user-overwatch-target:/u);
  assert.match(migration, /if v_existing_hash = v_request_hash then[\s\S]*jsonb_set\(v_existing_receipt, '\{replayed\}'/u);
  assert.match(migration, /USER_OVERWATCH_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /USER_OVERWATCH_STALE_STATE/u);
  assert.match(migration, /clock_timestamp\(\)/u);
  assert.match(migration, /actor_display_name/u);
  assert.match(migration, /actor_role_key/u);
});

test("Overwatch functions are hardened and do not touch product or notification domains", () => {
  for (const signature of [
    "get_user_overwatch_manage_target(text,text)",
    "list_user_overwatch_entries(text,text,integer,integer)",
    "add_user_to_overwatch(text,text,text,bigint,text,uuid)",
    "remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid)",
  ]) {
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${signature.replaceAll("(", "\\(").replaceAll(")", "\\)")}[\\s\\S]*to service_role`, "u"),
    );
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /USER_OVERWATCH_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.doesNotMatch(migration, /public\.(?:notifications|notification_push_jobs|user_flag_cases|user_warning_auto_flag_cases|user_warnings|community_comments)/u);
  assert.doesNotMatch(migration, /insert into public\.(?:notifications|notification_push_jobs)/u);
});
