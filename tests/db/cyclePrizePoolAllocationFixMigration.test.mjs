import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../../supabase/migrations/20260821000400_cycle_prize_pool_allocation_projection_fix.sql", import.meta.url), "utf8");

test("allocation fix is additive and restores the complete insert projection", () => {
  assert.match(sql, /^begin;/u);
  assert.match(sql, /create or replace function public\.allocate_cycle_prize_component/u);
  assert.match(sql, /donation_lamports,[\s\S]*payout_choice, split_percent,[\s\S]*organization_source_type/u);
  assert.match(sql, /end,[\s\S]*payout_choice,[\s\S]*split_percent,[\s\S]*case when payout_choice in \('donate', 'split'\)/u);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/iu);
  assert.match(sql, /owner to postgres/u);
  assert.match(sql, /search_path=public, pg_temp/u);
  assert.match(sql, /commit;\s*$/u);
});
