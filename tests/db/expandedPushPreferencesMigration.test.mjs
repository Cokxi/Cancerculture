import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cycleMigration = await readFile(new URL(
  "../../supabase/migrations/20260822000200_cycle_push_preferences_and_payout_notification.sql",
  import.meta.url
), "utf8");
const communityMigration = await readFile(new URL(
  "../../supabase/migrations/20260822000300_community_vote_announcement_push.sql",
  import.meta.url
), "utf8");

test("Cycle Push preferences are per-device, independently combinable, and exact", () => {
  assert.match(cycleMigration, /create table public\.push_cycle_preferences/u);
  for (const column of [
    "new_cycle_started", "submission_phase_ends", "voting_phase_ends",
    "cycle_results_ready", "remind_15_minutes", "remind_10_minutes",
    "remind_5_minutes",
  ]) assert.match(cycleMigration, new RegExp(`${column} boolean not null default false`, "u"));
  assert.match(cycleMigration, /cycle_submission_ended'[\s\S]*not \(v_cycle\.remind_15_minutes or v_cycle\.remind_10_minutes or v_cycle\.remind_5_minutes\)/u);
  assert.match(cycleMigration, /foreach v_lead in array array\[15, 10, 5\]/u);
  assert.match(cycleMigration, /extract\(epoch from v_cycle\.deadline_at\)/u);
  assert.match(cycleMigration, /on conflict \(producer_key\) do nothing/u);
  assert.doesNotMatch(cycleMigration, /setInterval|service_role[^\n]*insert into public\.push_cycle_preferences/iu);
});

test("a published winner payout produces one generic account notification", () => {
  assert.match(cycleMigration, /after insert on public\.payout_events/u);
  assert.match(cycleMigration, /new\.event_type = 'plan_published'/u);
  assert.match(cycleMigration, /'winner_payout_sent', 'winners_claims'/u);
  assert.match(cycleMigration, /allocation\.winner_lamports > 0/u);
  assert.doesNotMatch(
    cycleMigration.slice(
      cycleMigration.indexOf("create function public.produce_winner_payout_sent_notification"),
      cycleMigration.indexOf("create trigger payout_events_produce_winner_payout_sent_notification")
    ),
    /signature|recipient|lamports::text/iu
  );
});

test("Community Vote announcement is explicit, one-time, and activation has no send path", () => {
  assert.match(communityMigration, /create table public\.community_poll_announcements/u);
  assert.match(communityMigration, /poll_id uuid primary key/u);
  assert.match(communityMigration, /create function public\.announce_community_poll/u);
  assert.match(communityMigration, /'community_vote_announced', 'community_votes', 'broadcast'/u);
  assert.match(communityMigration, /insert into public\.notification_broadcast_jobs/u);
  assert.match(communityMigration, /poll\.deadline_at > transaction_timestamp\(\)/u);
  assert.match(communityMigration, /'participated'/u);
  assert.doesNotMatch(communityMigration, /create or replace function public\.activate_community_poll/u);
});
