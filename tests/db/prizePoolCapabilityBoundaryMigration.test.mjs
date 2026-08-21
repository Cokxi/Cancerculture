import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const sql = await readFile(
  new URL(
    "../../supabase/migrations/20260821000600_prize_pool_cycle_capability_boundary.sql",
    import.meta.url
  ),
  "utf8"
);

test("capability catalog assigns prize-pool management only to cycles.manage", () => {
  const cycle = TEAM_CAPABILITY_REGISTRY["cycles.manage"];
  const payouts = TEAM_CAPABILITY_REGISTRY["winners.manage_payouts"];
  assert.equal(cycle.implementationVersion, 2);
  assert.equal(payouts.implementationVersion, 2);
  assert.match(cycle.includedActions.join(" "), /prize pool/u);
  assert.match(payouts.excludedActions.join(" "), /Cycle prize pool/u);
  assert.doesNotMatch(payouts.includedActions.join(" "), /prize pool/u);
  assert.match(sql, new RegExp(cycle.definitionHash, "u"));
  assert.match(sql, new RegExp(payouts.definitionHash, "u"));
  assert.match(sql, /display_name = 'Manage Payouts'/u);
  assert.doesNotMatch(sql, /insert into public\.team_role_capabilities/iu);
  assert.doesNotMatch(sql, /delete from public\.team_role_capabilities/iu);
});

test("both database guards fail closed on the updated exact definitions", () => {
  assert.match(
    sql,
    /create or replace function public\.assert_cycle_manager[\s\S]*implementation_version = 2[\s\S]*c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a/u
  );
  assert.match(
    sql,
    /create or replace function public\.assert_winners_payout_capability[\s\S]*37bc1cd814466cbdca9276fe722bd610ced8b7baf1106b905f8a62a51a8c7a26[\s\S]*v_version := case/u
  );
  assert.match(
    sql,
    /revoke all on function[\s\S]*assert_cycle_manager[\s\S]*assert_winners_payout_capability[\s\S]*from public, anon, authenticated, discord_bot, service_role/u
  );
});
