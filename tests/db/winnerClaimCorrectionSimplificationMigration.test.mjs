import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migration = await readFile(
  new URL("../../supabase/migrations/20260818000100_simplify_winner_recipient_corrections.sql", import.meta.url),
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

test("the simplification migration advances the exact zero-grant correction capability", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["winners.recipient_corrections.manage"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");
  assert.equal(definition.implementationVersion, 2);
  assert.equal(hash, "e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd");
  assert.equal(definition.definitionHash, hash);
  assert.match(migration, /implementation_version = 2[\s\S]*e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd/u);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.team_role_capabilities/iu);
});

test("new correction proposals need only the exact address and replace the legacy overload", () => {
  assert.match(migration, /alter column case_reference drop not null[\s\S]*alter column reported_at drop not null/u);
  assert.match(migration, /create function public\.manage_winner_recipient_correction\([\s\S]*p_proposed_recipient text[\s\S]*returns jsonb/u);
  assert.match(migration, /drop function public\.manage_winner_recipient_correction\([\s\S]*timestamptz/u);
  assert.match(migration, /p_claim_id, v_version, null, null,[\s\S]*p_proposed_recipient, 'ready'/u);
  assert.match(migration, /claim_deadline_at = v_now \+ interval '24 hours'/u);
  assert.doesNotMatch(migration.match(/create function public\.manage_winner_recipient_correction[\s\S]*?\$function\$;/u)?.[0] ?? "", /p_case_reference|p_reported_at|record_pending|report_too_late/u);
});

test("winner rejection is closed in the RPC while historical rows remain migration-safe", () => {
  const mutation = migration.match(/create or replace function public\.mutate_own_winner_claim[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(mutation, /p_action not in \('confirm', 'decline'\)/u);
  assert.doesNotMatch(mutation, /correction_incorrect|status = 'incorrect'/u);
  assert.doesNotMatch(migration, /drop column case_reference|drop column reported_at|delete from public\.winner_/iu);
});

test("authoritative expiry is publicly projected as one safe boolean and correction clears it", () => {
  const due = migration.match(/create or replace function public\.process_due_winner_claim_transitions[\s\S]*?\$function\$;/u)?.[0] ?? "";
  const correction = migration.match(/create function public\.manage_winner_recipient_correction[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(migration, /add column claim_expired boolean not null default false/u);
  assert.match(due, /claim_deadline_at <= v_now/u);
  assert.match(due, /status = 'expired'[\s\S]*claim_expired = true/u);
  assert.match(correction, /claim_deadline_at = v_now \+ interval '24 hours'[\s\S]*claim_expired = false/u);
  assert.match(migration, /winner\.claim_expired <> \(claim\.status = 'expired'\)/u);
});

test("Team correction reads omit legacy Tally metadata and preserve double capability enforcement", () => {
  const teamRead = migration.match(/create or replace function public\.get_team_winner_claims[\s\S]*?\$function\$;/u)?.[0] ?? "";
  const correction = migration.match(/create function public\.manage_winner_recipient_correction[\s\S]*?\$function\$;/u)?.[0] ?? "";
  for (const body of [teamRead, correction]) {
    assert.ok(body.indexOf("winners.payouts.view") < body.indexOf("winners.recipient_corrections.manage"));
    assert.match(body, /e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd/u);
  }
  assert.doesNotMatch(teamRead, /caseReference|reportedAt/u);
  assert.match(teamRead, /'proposedRecipient', correction\.proposed_recipient/u);
});

test("owners, fixed search paths, exact service ACLs, and one correction overload are postflight guarded", () => {
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /alter function public\.manage_winner_recipient_correction\(text,uuid,uuid,bigint,text\)[\s\S]*owner to postgres/u);
  assert.match(migration, /grant execute on function public\.manage_winner_recipient_correction\(text,uuid,uuid,bigint,text\)[\s\S]*to service_role/u);
  assert.match(migration, /function_row\.proname = 'manage_winner_recipient_correction'[\s\S]*<> 1/u);
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/u);
});
