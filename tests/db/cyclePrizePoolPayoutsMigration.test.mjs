import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../../supabase/migrations/20260821000300_cycle_prize_pool_payouts_and_logs.sql", import.meta.url), "utf8");
const block = (name, next) => sql.slice(sql.indexOf(`create function public.${name}`), sql.indexOf(`create function public.${next}`, sql.indexOf(`create function public.${name}`) + 1));

test("migration is additive, exact-baseline guarded, and introduces two zero-grant capabilities", () => {
  assert.match(sql, /^begin;/u); assert.match(sql, /PAYOUT_FOUNDATION_BASELINE_MISMATCH/u);
  assert.match(sql, /count\(\*\) from public\.capability_catalog\) <> 41/u);
  assert.match(sql, /count\(\*\) from public\.capability_catalog\) <> 43/u);
  assert.match(sql, /winners\.manage_payouts/u); assert.match(sql, /winners\.payout_logs\.view/u);
  assert.doesNotMatch(sql, /insert into public\.team_role_capabilities/iu);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/iu); assert.match(sql, /commit;\s*$/u);
});

test("exact Lamport snapshots use deterministic largest remainder and donation receives the split floor remainder", () => {
  const allocation = block("allocate_cycle_prize_component", "manage_cycle_prize_pool");
  assert.match(allocation, /floor\(v_component\.amount_lamports::numeric \* weight \/ total_weight\)::bigint/u);
  assert.match(allocation, /row_number\(\) over \(order by \(exact_lamports - base_lamports::numeric\) desc, tie_key asc\)/u);
  assert.match(allocation, /digest\(convert_to\(claim\.id::text, 'utf8'\), 'sha256'\)/u);
  assert.match(allocation, /floor\(gross::numeric \* split_percent::numeric \/ 100\)::bigint/u);
  assert.match(allocation, /gross - floor\(gross::numeric \* split_percent::numeric \/ 100\)::bigint/u);
  assert.match(allocation, /v_total <> v_component\.amount_lamports/u);
});

test("finalization wraps the canonical transaction and preserves pending, base, supplement, replacement, and rollover components", () => {
  assert.match(sql, /rename to finalize_cycle_without_prize_pool/u);
  const finalization = block("finalize_cycle", "prepare_payout_plan");
  assert.match(finalization, /finalize_cycle_without_prize_pool/u);
  assert.match(finalization, /'amount_pending'/u); assert.match(finalization, /component_kind, amount_lamports/u);
  assert.match(sql, /component_kind in \('base', 'determination', 'supplement', 'replacement', 'rollover'\)/u);
  assert.match(sql, /unique \(replaces_component_id\)/u); assert.match(sql, /cycle_prize_pool_rollover_source_idx[\s\S]*source_payout_line_id/u);
});

test("prepare is canonical and Claim-gated without browser-controlled identity or amount", () => {
  const prepare = block("prepare_payout_plan", "manage_payout_plan");
  assert.match(prepare, /p_allocation_public_id uuid/u); assert.match(prepare, /p_expected_claim_version bigint/u);
  assert.doesNotMatch(prepare, /p_winner|p_user|p_amount|p_recipient/iu);
  assert.match(prepare, /payout_choice = 'donate'[\s\S]*claim\.status <> 'not_required'/u);
  assert.match(prepare, /payout_choice in \('keep', 'split'\)[\s\S]*claim\.status <> 'confirmed'/u);
  assert.match(sql, /unique \(allocation_id, plan_version\)/u);
});

test("mutations are versioned, idempotent, append-only, capability protected, and signatures globally unique", () => {
  for (const fn of ["manage_cycle_prize_pool", "prepare_payout_plan", "manage_payout_plan", "record_payout_transaction", "attach_payout_private_evidence"]) {
    const start = sql.indexOf(`create function public.${fn}`); assert.ok(start >= 0);
    const next = sql.indexOf("create function public.", start + 24); const text = sql.slice(start, next < 0 ? sql.length : next);
    assert.match(text, /assert_winners_payout_capability/u); assert.match(text, /security definer/u); assert.match(text, /set search_path = public, pg_temp/u);
  }
  assert.match(sql, /payout_mutation_requests/u); assert.match(sql, /PAYOUT_REQUEST_REUSED/u);
  assert.match(sql, /signature text not null unique/u); assert.match(sql, /reject_payout_append_only_rewrite/u);
  assert.match(sql, /enable row level security/u); assert.match(sql, /revoke all on table[\s\S]*service_role/u);
});

test("unavailable donations only apply explicit poll dispositions and return claims are database-time bounded", () => {
  const manage = block("manage_payout_plan", "record_payout_transaction");
  assert.match(manage, /'rollover', 'alternative_organization', 'return_to_winner', 'follow_up_poll'/u);
  assert.match(manage, /transaction_timestamp\(\) \+ interval '24 hours'/u);
  assert.match(manage, /component_kind, amount_lamports, source_payout_line_id/u);
  assert.doesNotMatch(manage, /create_community_poll|activate_community_poll/u);
  const own = block("mutate_own_payout_return_claim", "get_current_cycle_prize_pool");
  assert.match(own, /require_account_session/u); assert.match(own, /account_sol_profile_wallets/u);
  assert.doesNotMatch(own, /p_actor_discord_user_id|team_role/u);
});
