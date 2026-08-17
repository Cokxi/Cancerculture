import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260817000200_winner_claim_and_team_payout_status.sql", import.meta.url),
  "utf8"
);
const devContract = await readFile(
  new URL("./winnerClaimAndTeamPayoutStatus.dev.sql", import.meta.url),
  "utf8"
);

test("Winner Claim migration is additive, baseline-guarded, and registers one zero-grant correction capability", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /WINNER_CLAIM_BASELINE_MISMATCH/u);
  assert.match(migration, /create table public\.winner_claims/u);
  assert.match(migration, /unique \(cycle_id, submission_id\)/u);
  assert.match(migration, /create table public\.winner_recipient_corrections/u);
  assert.match(migration, /column_info\.column_name = 'wallet_address'[\s\S]*<> 'NO'/u);
  assert.match(migration, /alter table public\.winner_public_profiles[\s\S]*alter column wallet_address drop not null/u);
  assert.match(migration, /winners\.recipient_corrections\.manage/u);
  assert.match(migration, /where capability_key = 'winners\.recipient_corrections\.manage'/u);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.team_role_capabilities/iu);
  assert.match(migration, /\(select count\(\*\) from public\.capability_catalog\) <> 39/u);
});

test("the canonical six states, donation rules, and immutable confirmed recipient are constrained", () => {
  for (const state of ["not_required", "unclaimed", "correction_pending", "confirmed", "declined", "expired"]) {
    assert.match(migration, new RegExp(`'${state}'`, "u"));
  }
  assert.match(migration, /status = 'not_required'[\s\S]*payout_choice = 'donate'[\s\S]*confirmed_recipient is null/u);
  assert.match(migration, /status = 'confirmed'[\s\S]*is_valid_sol_recipient_address\(confirmed_recipient\)/u);
  assert.match(migration, /status <> 'confirmed'[\s\S]*confirmed_recipient is null/u);
  assert.match(migration, /update public\.winner_claims[\s\S]*status = 'confirmed'[\s\S]*confirmed_recipient = v_address/u);
  assert.doesNotMatch(migration, /update public\.winner_claims[\s\S]*confirmed_recipient = [^v]/u);
});

test("database-time deadlines use an exact closed expiry boundary and correction restart", () => {
  assert.match(migration, /v_now timestamptz := transaction_timestamp\(\)/u);
  assert.match(migration, /claim\.claim_deadline_at <= v_now/u);
  assert.match(migration, /v_claim\.claim_deadline_at <= v_now/u);
  assert.match(migration, /v_finalized_at \+ interval '24 hours'/u);
  assert.match(migration, /p_action = 'propose' then v_now \+ interval '24 hours'/u);
  assert.match(migration, /p_reported_at > v_claim\.finalized_at[\s\S]*report_too_late/u);
  assert.match(migration, /p_action = 'record_pending'[\s\S]*status = case when p_action = 'propose' then 'unclaimed' else 'correction_pending'/u);
});

test("recipient precedence and confirmation re-resolution share Wallet and 2FA serialization", () => {
  const resolver = migration.match(/create function public\.resolve_winner_claim_candidate[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.ok(resolver.indexOf("account_sol_profile_wallets") < resolver.indexOf("winner_recipient_corrections"));
  assert.ok(resolver.indexOf("winner_recipient_corrections") < resolver.indexOf("submission_private_data"));
  assert.match(resolver, /account_totp_factors/u);
  const mutation = migration.match(/create function public\.mutate_own_winner_claim[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(mutation, /for update/u);
  assert.ok(mutation.indexOf("sol-profile-wallet:") < mutation.indexOf("account-2fa:"));
  assert.ok(mutation.lastIndexOf("resolve_winner_claim_candidate") > mutation.indexOf("account-2fa:"));
  assert.match(mutation, /v_revision <> p_expected_candidate_revision[\s\S]*candidate_stale/u);
  assert.match(mutation, /winner_claim_requests[\s\S]*idempotentReplay/u);
});

test("finalization creates one Claim for every tied winner and never publishes a provisional Wallet", () => {
  const wrapper = migration.match(/create function public\.finalize_cycle\([\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(wrapper, /finalize_cycle_without_winner_claims/u);
  assert.match(wrapper, /insert into public\.winner_claims/u);
  assert.match(wrapper, /from public\.winner_public_profiles winner/u);
  assert.doesNotMatch(wrapper, /limit 1/u);
  assert.match(wrapper, /v_claim_count <> v_winner_count/u);
  assert.match(wrapper, /update public\.winner_public_profiles winner[\s\S]*set wallet_address = null/u);
  assert.match(migration, /winner\.payout_choice = 'donate' then 'not_required' else 'unclaimed'/u);
});

test("Team and public projections disclose an exact Wallet only after a confirmed keep or split Claim", () => {
  const teamRead = migration.match(/create function public\.get_team_winner_claims[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(teamRead, /assert_winner_capability[\s\S]*winners\.payouts\.view/u);
  assert.match(teamRead, /when claim\.status = 'confirmed' and claim\.payout_choice in \('keep', 'split'\)[\s\S]*then claim\.confirmed_recipient[\s\S]*else null/u);
  assert.match(teamRead, /when p_include_corrections[\s\S]*proposedRecipient/u);
  assert.match(migration, /update public\.winner_public_profiles[\s\S]*set wallet_address = v_address/u);
  assert.match(migration, /update public\.winner_public_profiles[\s\S]*set wallet_address = null/u);
});

test("RLS, ownership, fixed search paths, exact service RPC grants, and closed helper ACLs are explicit", () => {
  for (const table of ["winner_claims", "winner_recipient_corrections", "winner_claim_requests", "winner_correction_requests", "winner_claim_events"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}[\\s\\S]*service_role`, "u"));
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /alter function public\.get_own_winner_claim[\s\S]*owner to postgres/u);
  assert.match(migration, /grant execute on function public\.get_own_winner_claims\(uuid\)[\s\S]*to service_role/u);
  assert.match(migration, /revoke all on function public\.resolve_winner_claim_candidate\(uuid,text\)[\s\S]*service_role/u);
});

test("the block contains no payout execution, amount, transaction, or redistribution implementation", () => {
  assert.doesNotMatch(migration, /create (?:table|function) public\.(?:payout|redistribut)|treasury_private_key|send_(?:sol|transaction)|\blamports\b|transaction_signature/iu);
});

test("the DEV contract is rollback-only and covers deadlines, stale retries, precedence, correction replacement, and privacy", () => {
  assert.match(devContract, /^begin;/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_BEFORE_BOUNDARY_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_EXACT_BOUNDARY_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_AFTER_BOUNDARY_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_MULTI_WINNER_FINALIZATION_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_FINALIZATION_IDEMPOTENCY_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_IMMEDIATE_PROFILE_CHANGE_MISMATCH/u);
  assert.match(devContract, /idempotentReplay/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_LATE_2FA_PROFILE_PRECEDENCE_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_CORRECTION_RESTART_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_CORRECTION_REPLACEMENT_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_CORRECTION_REPLACEMENT_CANDIDATE_MISMATCH/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_CORRECTION_REJECTION_ACCEPTED/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_UNAUTHORIZED_CORRECTION_ACCEPTED/u);
  assert.match(devContract, /WINNER_CLAIM_DEV_TEAM_PRIVACY_MISMATCH/u);
  assert.match(devContract, /rollback;\s*$/u);
  assert.doesNotMatch(devContract, /\bcommit\b/iu);
});
