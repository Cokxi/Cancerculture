import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL(
    "../../supabase/migrations/20260821000500_cycle_prize_pool_vote_deadline.sql",
    import.meta.url
  ),
  "utf8"
);

test("prize pools become a current-Cycle setting with a hard voting deadline", () => {
  assert.match(
    sql,
    /create function public\.manage_current_cycle_prize_pool/u
  );
  assert.match(sql, /public\.assert_cycle_manager\(v_actor_id\)/u);
  assert.match(
    sql,
    /p_confirmed_amount_lamports <> p_amount_lamports/u
  );
  assert.match(
    sql,
    /cycle\.id = \(select max\(current_cycle\.id\)/u
  );
  assert.match(
    sql,
    /cycle\.status::text <> 'voting_open'[\s\S]*cycle\.voting_ends_at > p_database_time/u
  );
  assert.match(sql, /CYCLE_PRIZE_POOL_DEADLINE_PASSED/u);
});

test("retroactive pool mutation paths are removed and guarded", () => {
  assert.match(
    sql,
    /drop function public\.manage_cycle_prize_pool/u
  );
  assert.match(
    sql,
    /component_kind in \('determination', 'supplement', 'replacement'\)/u
  );
  assert.match(sql, /PAYOUT_ROLLOVER_TARGET_INVALID/u);
  assert.match(sql, /cycle_prize_pool_lifecycle_guard/u);
  assert.match(sql, /cycle_prize_pool_component_insert_guard/u);
  assert.doesNotMatch(sql, /delete from public\.cycle_prize_pools/iu);
  assert.doesNotMatch(sql, /set\s+state = 'amount_pending'/iu);
});

test("finalization leaves a missing pool absent and allocates only a pre-set pool", () => {
  const finalization = sql.slice(
    sql.indexOf("create or replace function public.finalize_cycle"),
    sql.indexOf("alter function public.is_cycle_prize_pool_editable")
  );
  assert.match(
    finalization,
    /if not found then[\s\S]*'prizePoolState', 'none'/u
  );
  assert.match(
    finalization,
    /v_pool\.announced_lamports is not null[\s\S]*'base'/u
  );
  assert.doesNotMatch(finalization, /insert into public\.cycle_prize_pools/iu);
  assert.doesNotMatch(finalization, /'amount_pending'[\s\S]*insert/iu);
});

test("only the server role can call the exact management surfaces", () => {
  assert.match(
    sql,
    /revoke all on function[\s\S]*manage_current_cycle_prize_pool[\s\S]*from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    sql,
    /grant execute on function[\s\S]*manage_current_cycle_prize_pool[\s\S]*get_cycle_prize_pool_management_context[\s\S]*to service_role/u
  );
});
