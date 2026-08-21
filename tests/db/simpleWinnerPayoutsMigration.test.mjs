import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = await readFile(new URL("supabase/migrations/20260821000700_simple_winner_payouts_and_donation_corrections.sql", root), "utf8");

test("donation corrections preserve the locked payout and give the winner an audited 24-hour recipient-only window", () => {
  assert.match(source, /create table public\.payout_donation_corrections/u);
  assert.match(source, /deadline_at timestamptz/u);
  assert.match(source, /transaction_timestamp\(\) \+ interval '24 hours'/u);
  assert.match(source, /create function public\.request_donation_recipient_correction/u);
  assert.match(source, /create function public\.submit_own_donation_recipient_correction/u);
  assert.match(source, /selection_source in \('catalog', 'other'\)/u);
  assert.doesNotMatch(source.match(/create function public\.submit_own_donation_recipient_correction[\s\S]*?\$function\$;/u)?.[0] ?? "", /split_percent|winner_lamports|donation_lamports\s*=/u);
  assert.match(source, /'donation_recipient_change_required'/u);
  assert.match(source, /insert into public\.payout_events/u);
});

test("simple completion verifies exact immutable amounts and publishes in one server transaction", () => {
  const completion = source.match(/create function public\.complete_and_publish_payout[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(completion, /p_winner_verified_lamports is distinct from v_allocation\.winner_lamports/u);
  assert.match(completion, /p_donation_verified_lamports is distinct from v_allocation\.donation_lamports/u);
  assert.match(completion, /coalesce\(max\(plan_version\), 0\) \+ 1/u);
  assert.match(completion, /set state = 'published'/u);
  assert.match(completion, /public_approved/u);
  assert.doesNotMatch(completion, /create_community|community_poll|link_poll/u);
});

test("payout blocking is public-reasoned, append-only, and never starts a Community Decision", () => {
  const disqualify = source.match(/create function public\.disqualify_payout_allocation[\s\S]*?\$function\$;/u)?.[0] ?? "";
  assert.match(disqualify, /public_reason/u);
  assert.match(disqualify, /'payout_disqualified'/u);
  assert.doesNotMatch(disqualify, /community_poll|create_poll|link_poll/u);
  assert.match(source, /when disqualification\.id is not null then 'payout_disqualified'/u);
  assert.match(source, /'publicReason', coalesce\(disqualification\.public_reason, correction\.public_reason\)/u);
});

test("new payout tables are RLS protected and privileged functions are service-role only", () => {
  assert.match(source, /enable row level security/u);
  assert.match(source, /revoke all on table[\s\S]*payout_donation_corrections[\s\S]*from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(source, /revoke all on function[\s\S]*complete_and_publish_payout[\s\S]*from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(source, /grant execute on function[\s\S]*complete_and_publish_payout[\s\S]*to service_role/u);
});
