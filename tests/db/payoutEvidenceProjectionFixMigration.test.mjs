import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = await readFile(new URL("supabase/migrations/20260821000800_payout_evidence_projection_timestamp_fix.sql", root), "utf8");

test("the additive repair updates both payout projections to the canonical evidence timestamp", () => {
  assert.match(source, /get_simple_team_payouts\(text,boolean\)/u);
  assert.match(source, /get_public_submission_payout\(bigint\)/u);
  assert.match(source, /candidate\.created_at/u);
  assert.match(source, /candidate\.uploaded_at/u);
  assert.match(source, /PAYOUT_EVIDENCE_TIMESTAMP_BASELINE_MISSING/u);
  assert.doesNotMatch(source, /alter table|drop table|delete from|truncate/iu);
});
