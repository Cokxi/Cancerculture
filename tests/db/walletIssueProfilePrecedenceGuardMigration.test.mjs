import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260818000800_profile_wallet_owner_control_guard.sql", import.meta.url),
  "utf8"
);

test("active 2FA Profile Wallet removes every Team recipient correction path", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /create function public\.protect_team_correction_profile_wallet_control/u);
  assert.match(migration, /if new\.status <> 'ready'/u);
  assert.doesNotMatch(migration, /new\.case_reference/u);
  assert.match(migration, /account_sol_profile_wallets/u);
  assert.match(migration, /account_totp_factors/u);
  assert.match(migration, /WINNER_PROFILE_WALLET_OWNER_CONTROLLED/u);
  assert.match(migration, /before insert on public\.winner_recipient_corrections/u);
});

test("Winner Payouts exposes owner control and suppresses correction eligibility", () => {
  assert.match(migration, /create or replace function public\.get_team_winner_claims/u);
  assert.match(migration, /'profileWalletOwnerControlled', profile_wallet\.owner_controlled/u);
  assert.match(migration, /'correctionEligible', not profile_wallet\.owner_controlled and exists/u);
});

test("the guard is fixed-path, postgres-owned, and unavailable to service_role", () => {
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /alter function public\.protect_team_correction_profile_wallet_control\(\) owner to postgres/u);
  assert.match(migration, /revoke all on function public\.protect_team_correction_profile_wallet_control\(\)[\s\S]*service_role/u);
  assert.match(migration, /grant execute on function public\.get_team_winner_claims\(text,boolean\)[\s\S]*to service_role/u);
});
