import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = await readFile(new URL("supabase/migrations/20260821000900_simple_payout_claim_deadline_fix.sql", root), "utf8");

test("the additive repair uses the canonical Winner Claim deadline column", () => {
  assert.match(source, /get_simple_team_payouts\(text,boolean\)/u);
  assert.match(source, /claim\.deadline_at/u);
  assert.match(source, /claim\.claim_deadline_at/u);
  assert.match(source, /SIMPLE_PAYOUT_CLAIM_DEADLINE_BASELINE_MISSING/u);
  assert.doesNotMatch(source, /alter table|drop table|delete from|truncate/iu);
});
