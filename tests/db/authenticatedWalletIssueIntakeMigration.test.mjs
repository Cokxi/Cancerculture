import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260818000700_authenticated_wallet_issue_intake.sql",
    import.meta.url
  ),
  "utf8"
);

test("Wallet Issue intake is submission-bound, private, and held outside the Inbox", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /create table public\.wallet_issue_intakes/u);
  assert.match(migration, /unique \(cycle_id, submission_id\)/u);
  assert.match(migration, /status in \('held', 'promoted', 'not_relevant', 'resolved'\)/u);
  assert.match(migration, /create function public\.create_own_wallet_issue_intake/u);
  assert.match(migration, /submission\.discord_user_id <> v_owner_id/u);
  assert.match(migration, /v_private\.payout_choice not in \('keep', 'split'\)/u);
  assert.doesNotMatch(
    migration.match(/create function public\.create_own_wallet_issue_intake[\s\S]*?\$function\$;/u)?.[0] ?? "",
    /upsert_team_inbox_case/u
  );
});

test("finalization promotes only the exact winning submission and marks all other intakes for purge", () => {
  const wrapper = migration.match(
    /create function public\.finalize_cycle\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(wrapper, /finalize_cycle_without_wallet_issue_intakes/u);
  assert.match(wrapper, /claim\.submission_id = v_intake\.submission_id/u);
  assert.match(wrapper, /claim\.cycle_id = v_intake\.cycle_id/u);
  assert.match(wrapper, /status = 'correction_pending'/u);
  assert.match(wrapper, /upsert_team_inbox_case/u);
  assert.match(wrapper, /status = 'not_relevant'/u);
  assert.match(wrapper, /v_finalized_at \+ interval '14 days'/u);
});

test("irrelevant intake and screenshot bytes are hard-deleted only after the database-time deadline", () => {
  const purge = migration.match(
    /create function public\.purge_due_wallet_issue_intakes\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(purge, /delete from public\.wallet_issue_intakes/u);
  assert.match(purge, /status = 'not_relevant'/u);
  assert.match(purge, /delete_after <= transaction_timestamp\(\)/u);
  assert.doesNotMatch(purge, /status in \(|status = 'promoted'|status = 'resolved'/u);
});

test("the Intake Monitor uses the same exact Wallet Issues capability combination", () => {
  const monitor = migration.match(
    /create function public\.get_team_wallet_issue_intakes[\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(monitor, /assert_team_inbox_topic_access[\s\S]*'wallet_issues'/u);
  assert.match(migration, /winners\.payouts\.view/u);
  assert.match(migration, /winners\.recipient_corrections\.manage/u);
  assert.doesNotMatch(migration, /insert into public\.capability_catalog/u);
  assert.doesNotMatch(migration, /insert into public\.team_role_capabilities/u);
});

test("resolution is assignee-only, replay-safe, version-guarded, and winner-confirmed", () => {
  const resolution = migration.match(
    /create function public\.resolve_wallet_issue_case[\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(resolution, /p_resolution not in \('accept_correction', 'no_action'\)/u);
  assert.match(resolution, /wallet_issue_resolution_requests/u);
  assert.match(resolution, /for update/u);
  assert.match(resolution, /v_case\.assignee_discord_user_id <> v_actor_id/u);
  assert.match(resolution, /p_expected_case_row_version/u);
  assert.match(resolution, /p_expected_case_work_version/u);
  assert.match(resolution, /p_expected_source_version/u);
  assert.match(resolution, /p_expected_intake_version/u);
  assert.match(resolution, /p_expected_claim_version/u);
  assert.match(resolution, /v_current_candidate is distinct from v_intake\.desired_recipient/u);
  assert.match(resolution, /status = 'unclaimed'/u);
  assert.match(resolution, /claim_deadline_at = v_now \+ interval '24 hours'/u);
  assert.doesNotMatch(resolution, /status = 'confirmed'|confirmed_recipient =/u);
});

test("Wallet Issue notifications are generic and the topic becomes active without grants", () => {
  assert.match(migration, /'wallet_issues', 'Wallet Issues'/u);
  assert.match(migration, /wallet_issue_received/u);
  assert.match(migration, /wallet_issue_correction_ready/u);
  assert.match(migration, /wallet_issue_resolved/u);
  assert.match(migration, /set is_active = true,[\s\S]*accepts_new_cases = true/u);
  const notificationCopy = migration.match(
    /create or replace function public\.get_own_notifications[\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.doesNotMatch(notificationCopy, /desired_recipient|description|screenshot/u);
});

test("all Wallet Issue tables and RPCs are closed behind RLS and service-role calls", () => {
  for (const table of [
    "wallet_issue_intakes",
    "wallet_issue_intake_requests",
    "wallet_issue_resolution_requests",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}`, "u"));
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /grant execute on function public\.create_own_wallet_issue_intake[\s\S]*to service_role/u);
  assert.match(migration, /revoke all on function public\.resolve_wallet_issue_current_candidate/u);
});
