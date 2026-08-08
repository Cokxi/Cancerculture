import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260808000100_manual_vote_refund.sql",
    repoRoot
  ),
  "utf8"
);
const devTransactionTest = await readFile(
  new URL("tests/db/manualVoteRefund.dev.sql", repoRoot),
  "utf8"
);
const devConcurrencyTest = await readFile(
  new URL("tests/db/manualVoteRefundConcurrency.dev.mjs", repoRoot),
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

test("the additive migration registers two exact zero-grant capabilities", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);

  for (const key of [
    "votes.refund_disqualified",
    "logs.vote_refunds.view",
  ]) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
      .digest("hex");
    assert.equal(hash, definition.definitionHash);
    assert.match(migration, new RegExp(`'${key.replaceAll(".", "\\.")}'`, "u"));
    assert.match(migration, new RegExp(hash, "u"));
  }

  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
  assert.match(migration, /VOTE_REFUND_CAPABILITY_POSTFLIGHT_MISMATCH/u);
});

test("the RPC is selective, state-bound, canonically locked and all-or-nothing", () => {
  assert.match(migration, /create function public\.refund_disqualified_votes\(/u);
  assert.match(migration, /security definer/u);
  assert.match(migration, /set search_path = public, pg_temp/u);
  assert.match(migration, /v_cycle\.status::text <> 'voting_open'/u);
  assert.match(migration, /v_cycle\.reset_count <> p_expected_reset_count/u);
  assert.match(migration, /v_cycle\.votes_per_user <> p_expected_votes_per_user/u);
  assert.match(migration, /not coalesce\(v_submission\.is_disqualified, false\)/u);
  assert.match(migration, /VOTE_REFUND_DISQUALIFICATION_CONFLICT/u);
  assert.match(migration, /VOTE_REFUND_COUNT_CONFLICT/u);
  assert.match(migration, /array_agg\(selection\.submission_id order by selection\.submission_id\)/u);
  assert.match(migration, /vote\.submission_id = any\(v_submission_ids\)/u);
  assert.doesNotMatch(migration, /where\s+submission\.is_disqualified\s*=\s*true\s*\)\s*delete/iu);
  assert.match(migration, /insert into public\.vote_refund_items[\s\S]*delete from public\.votes/u);
  assert.match(migration, /VOTE_REFUND_ATOMIC_COUNT_MISMATCH/u);
});

test("idempotency, append-only audit and dynamic vote settings are contractual", () => {
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*vote-refund:/u);
  assert.match(migration, /VOTE_REFUND_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /'votesPerUser', v_cycle\.votes_per_user/u);
  assert.match(migration, /create table public\.vote_refund_events/u);
  assert.match(migration, /create table public\.vote_refund_items/u);
  assert.match(migration, /before update or delete on public\.vote_refund_events/u);
  assert.match(migration, /before update or delete on public\.vote_refund_items/u);
  assert.match(migration, /original_vote_id/u);
  assert.match(migration, /voter_discord_user_id/u);
  assert.doesNotMatch(
    migration,
    /(?:ip_address|device_id|turnstile_token|cluster_id)\s+(?:text|inet|uuid|bigint)/iu
  );
});

test("refund data and mutation remain service-role only with hardened votes DML", () => {
  assert.match(migration, /grant select on table public\.vote_refund_events to service_role/u);
  assert.match(migration, /grant select on table public\.vote_refund_items to service_role/u);
  assert.match(migration, /grant select on table public\.vote_refund_candidates to service_role/u);
  assert.match(migration, /grant execute on function public\.refund_disqualified_votes\([\s\S]*to service_role/u);
  assert.match(migration, /revoke all on table public\.votes from service_role[\s\S]*grant select on table public\.votes to service_role/u);
  assert.doesNotMatch(
    migration,
    /grant (?:select|execute)[\s\S]{0,180}(?:vote_refund|refund_disqualified_votes)[\s\S]{0,80}to (?:anon|authenticated)/iu
  );
  assert.match(migration, /VOTE_REFUND_ACL_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /aclexplode\([\s\S]*privilege_row\.grantee = 0/u);
  assert.doesNotMatch(
    migration,
    /has_function_privilege\('PUBLIC'/u
  );
});

test("the practical DEV gate is rollback-safe and covers selective, stale, audit, and opposite-order concurrency paths", () => {
  assert.match(devTransactionTest, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devTransactionTest, /rollback;\s*$/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_SELECTIVE_REPLAY_AUDIT_FAILED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_IDEMPOTENCY_CONFLICT_ACCEPTED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_COUNT_CONFLICT_ACCEPTED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_DQ_CONFLICT_ACCEPTED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_REINSTATED_SELECTION_ACCEPTED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_ZERO_GRANT_ACCEPTED/u);
  assert.match(devTransactionTest, /MANUAL_VOTE_REFUND_EVENT_REWRITE_ACCEPTED/u);
  assert.match(devConcurrencyTest, /Promise\.allSettled/u);
  assert.match(devConcurrencyTest, /selections\(reverse/u);
  assert.match(devConcurrencyTest, /rollback;/u);
  assert.match(devConcurrencyTest, /MANUAL_VOTE_REFUND_CONCURRENCY_AUDIT_RESIDUE/u);
});
