import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260801000100_user_flag_escalation_workflow.sql",
    import.meta.url
  ),
  "utf8"
);

test("5C2 is a guarded forward-only transaction that preserves event history", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /user_flag_5c2_guard/u);
  assert.match(migration, /USER_FLAG_5C2_EVENT_HISTORY_CHANGED/u);
  assert.doesNotMatch(migration, /\b40001\b/u);
});

test("one active case covers open and escalated with deterministic conflicts", () => {
  assert.match(
    migration,
    /create unique index user_flag_cases_one_active_per_user_idx[\s\S]*where status in \('open', 'escalated'\)/u
  );
  assert.match(migration, /USER_FLAG_ACTIVE_CASE_CONFLICT/u);
  assert.match(migration, /errcode = 'PT409'/u);
  assert.match(migration, /status in \('open', 'escalated'\)/u);
});

test("escalation snapshots and transitions are append-only", () => {
  assert.match(migration, /create table public\.user_flag_actor_snapshots/u);
  assert.match(migration, /protect_user_flag_actor_snapshots/u);
  assert.match(migration, /'case_escalated'/u);
  assert.match(migration, /'case_banned_and_resolved'/u);
  assert.match(migration, /actor_account_id/u);
  assert.match(migration, /actor_username/u);
});

test("website ban resolution and participation enforcement share DB contracts", () => {
  assert.match(migration, /apply_website_ban_contract/u);
  assert.match(migration, /user_logs_website_ban_session_revocation_trigger/u);
  assert.match(migration, /PARTICIPATION_UNAVAILABLE/u);
  assert.match(migration, /user_flag_hold_submission_upload_operations/u);
  assert.match(migration, /user_flag_hold_submission_create/u);
  assert.match(migration, /user_flag_hold_vote_create_or_change/u);
});

test("review-only worklists and view history remain separate RPC surfaces", () => {
  assert.match(migration, /list_user_flag_review_worklist/u);
  assert.match(migration, /where status = 'open'/u);
  assert.match(migration, /p_section text/u);
  assert.match(migration, /p_limit integer/u);
  assert.match(migration, /p_offset integer/u);
  assert.match(migration, /known_discord_usernames/u);
});
