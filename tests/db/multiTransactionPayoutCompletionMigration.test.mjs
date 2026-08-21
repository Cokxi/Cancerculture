import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = await readFile(new URL("supabase/migrations/20260821001000_multi_transaction_payout_completion.sql", root), "utf8");
const timestampFix = await readFile(new URL("supabase/migrations/20260821001100_multi_transaction_payout_projection_timestamp_fix.sql", root), "utf8");

test("multi-transaction completion preserves every verified transfer and exact recipient binding", () => {
  const completion = source.match(/create function public\.complete_and_publish_payout_v2[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(source, /add column verified_lamports bigint/u);
  assert.match(source, /add column paid_lamports bigint/u);
  assert.match(completion, /jsonb_array_length\(p_winner_transactions\) > 10/u);
  assert.match(completion, /input\.recipient = v_claim\.confirmed_recipient/u);
  assert.match(completion, /input\.recipient = p_donation_operation_recipient/u);
  assert.match(completion, /count\(distinct input\.signature\)/u);
  assert.match(completion, /insert into public\.payout_transactions/u);
  assert.match(completion, /verified_lamports/u);
});

test("underpayment is rejected while overpayment requires explicit bounded public confirmation", () => {
  const completion = source.match(/create function public\.complete_and_publish_payout_v2[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(completion, /v_winner_total < v_allocation\.winner_lamports[\s\S]*'winner_underpaid'/u);
  assert.match(completion, /v_donation_total < v_allocation\.donation_lamports[\s\S]*'donation_underpaid'/u);
  assert.match(completion, /p_winner_overpayment_confirmed/u);
  assert.match(completion, /p_donation_overpayment_confirmed/u);
  assert.match(completion, /char_length\(p_winner_overpayment_reason\) not between 3 and 500/u);
  assert.match(completion, /char_length\(p_donation_overpayment_reason\) not between 3 and 500/u);
  assert.match(source, /winnerOverpaymentReason/u);
  assert.match(source, /donationOverpaymentReason/u);
});

test("v2 payout RPCs remain service-only and the legacy single completion path is retired", () => {
  assert.match(source, /revoke all on function public\.complete_and_publish_payout_v2[\s\S]*from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(source, /grant execute on function public\.complete_and_publish_payout_v2[\s\S]*to service_role/u);
  assert.match(source, /revoke execute on function public\.complete_and_publish_payout\([\s\S]*from service_role/u);
  assert.match(source, /create function public\.get_simple_team_payouts_v2/u);
  assert.match(source, /create function public\.get_public_submission_payout_v2/u);
});

test("the additive projection repair uses the canonical evidence upload timestamp", () => {
  assert.match(timestampFix, /PAYOUT_V2_PROJECTION_BASELINE_MISMATCH/u);
  assert.match(timestampFix, /candidate\.created_at/u);
  assert.match(timestampFix, /candidate\.uploaded_at/u);
  assert.match(timestampFix, /get_simple_team_payouts_v2\(text,boolean\)/u);
  assert.match(timestampFix, /get_public_submission_payout_v2\(bigint\)/u);
});
