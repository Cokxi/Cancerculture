import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../supabase/migrations/20260821001200_multi_transaction_payout_claim_deadline_fix.sql", import.meta.url),
  "utf8",
);

test("repairs only the v2 Team payout Winner Claim deadline projection", () => {
  assert.match(source, /get_simple_team_payouts_v2\(text,boolean\)/u);
  assert.match(source, /claim\.deadline_at/u);
  assert.match(source, /claim\.claim_deadline_at/u);
  assert.match(source, /PAYOUT_V2_CLAIM_DEADLINE_BASELINE_MISMATCH/u);
  assert.doesNotMatch(source, /get_public_submission_payout_v2/u);
});

test("keeps the repair additive and transactional", () => {
  assert.match(source, /^begin;/u);
  assert.match(source, /execute replace\(/u);
  assert.match(source, /commit;\s*$/u);
  assert.doesNotMatch(source, /drop\s+(?:table|column)/iu);
});
