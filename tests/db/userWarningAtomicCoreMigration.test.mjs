import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationPath =
  "supabase/migrations/20260826000500_user_warning_atomic_core.sql";
const sql = readFileSync(migrationPath, "utf8");

test("Warning core requires the exact current baseline and installs two zero-grant capabilities", () => {
  assert.match(sql, /USER_WARNING_CORE_DEPENDENCY_UNAVAILABLE/u);
  assert.match(sql, /USER_WARNING_CORE_CAPABILITY_BASELINE_MISMATCH/u);
  assert.match(sql, /select count\(\*\) from public\.capability_catalog\) <> 49/u);
  assert.match(sql, /users\.warnings\.issue/u);
  assert.match(sql, /users\.warnings\.overrule/u);
  assert.match(sql, /8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f/u);
  assert.match(sql, /ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece/u);
  assert.match(sql, /USER_WARNING_CORE_UNEXPECTED_GRANT/u);
  assert.doesNotMatch(
    sql,
    /insert into public\.team_role_capabilities/iu
  );
});

test("canonical Warning facts bind one source Comment and exact immutable object and text evidence", () => {
  assert.match(sql, /create table public\.user_warnings/u);
  assert.match(sql, /source_comment_id uuid not null unique/u);
  assert.match(sql, /source_public_comment_id uuid not null unique[\s\S]*references public\.community_comments\(public_comment_id\)/u);
  assert.match(sql, /source_comment_object_version bigint not null/u);
  assert.match(sql, /source_comment_text_version bigint not null/u);
  assert.match(sql, /source_comment_body text not null/u);
  assert.match(sql, /source_comment_body_digest text not null/u);
  assert.match(sql, /foreign key \(source_comment_id, source_comment_text_version\)[\s\S]*community_comment_text_versions/u);
  assert.match(sql, /USER_WARNING_SOURCE_ALREADY_USED/u);
  assert.match(sql, /USER_WARNING_STALE_SOURCE_VERSION/u);
  assert.match(sql, /protect_user_warnings[\s\S]*before update or delete/u);
});

test("Issue accepts category and reason but never a duration", () => {
  const issueBlock = sql.slice(
    sql.indexOf("create function public.issue_user_warning"),
    sql.indexOf("create function public.overrule_user_warning")
  );
  assert.match(
    issueBlock,
    /issue_user_warning\([\s\S]*p_category text,[\s\S]*p_reason text,[\s\S]*p_request_id uuid/u
  );
  assert.doesNotMatch(issueBlock, /p_(?:duration|tier|days)/iu);
  assert.match(issueBlock, /v_category not in \('spam', 'hate_speech', 'other'\)/u);
  assert.match(issueBlock, /clock_timestamp\(\)/u);
  assert.match(issueBlock, /public\.calculate_user_warning_tier/u);
  assert.match(issueBlock, /make_interval\(days => v_tier\)/u);
});

test("automatic progression is exactly 1 to 3 to 7 to 14 with the special three-day first recurrence window", () => {
  const tierBlock = sql.slice(
    sql.indexOf("create function public.calculate_user_warning_tier"),
    sql.indexOf("create function public.authorize_user_warning_capability")
  );
  for (const transition of [
    /when 1 then 3/u,
    /when 3 then 7/u,
    /when 7 then 14/u,
    /when 14 then 14/u,
  ]) assert.match(tierBlock, transition);
  assert.match(sql, /case original_tier_days[\s\S]*when 1 then 3/u);
  assert.match(sql, /p_issue_at > p_previous_recurrence_until[\s\S]*return 1/u);
});

test("current projection, immutable requests and lifecycle events are separate", () => {
  for (const table of [
    "user_warning_current",
    "user_warning_events",
    "user_warning_requests",
  ]) assert.match(sql, new RegExp(`create table public\\.${table}`, "u"));
  assert.match(sql, /event_type in \('issued', 'overruled', 'recalculated', 'expired'\)/u);
  assert.match(sql, /operation in \('issue', 'overrule'\)/u);
  assert.match(sql, /USER_WARNING_HISTORY_IS_APPEND_ONLY/u);
  assert.match(sql, /USER_WARNING_IDEMPOTENCY_CONFLICT/u);
  assert.match(sql, /USER_WARNING_STALE_VERSION/u);
  assert.match(sql, /jsonb_set\(v_existing_receipt, '\{replayed\}', 'true'::jsonb\)/u);
});

test("Overrule preserves the incident and deterministically replays every later non-overruled Warning", () => {
  const overruleBlock = sql.slice(
    sql.indexOf("create function public.overrule_user_warning"),
    sql.indexOf("create function public.process_due_user_warning_expiries")
  );
  assert.match(overruleBlock, /p_expected_row_version bigint/u);
  assert.match(overruleBlock, /event_type,[\s\S]*'overruled'/u);
  assert.match(overruleBlock, /public\.recalculate_user_warning_target/u);
  assert.match(sql, /order by warning_row\.issued_at, warning_row\.warning_id/u);
  assert.match(sql, /event_row\.event_type = 'overruled'[\s\S]*continue/u);
  assert.match(sql, /event_type,[\s\S]*'recalculated'/u);
  assert.match(sql, /original_tier_days/u);
  assert.doesNotMatch(overruleBlock, /delete from public\.user_warning/iu);
});

test("expiry and both automatic Flag triggers are database-time-based and sanction-free", () => {
  assert.match(sql, /create function public\.process_due_user_warning_expiries/u);
  assert.match(sql, /current_row\.expires_at <= clock_timestamp\(\)/u);
  assert.match(sql, /count\(\*\) >= 3/u);
  assert.match(sql, /bool_or\(current_row\.effective_tier_days = 14\)/u);
  assert.match(sql, /create table public\.user_warning_auto_flag_cases/u);
  assert.match(sql, /create unique index user_warning_auto_flag_one_open_idx/u);
  assert.match(sql, /event_type in \('opened', 'recomputed', 'closed'\)/u);

  const behaviorSql = sql.slice(
    sql.indexOf("create function public.sync_user_warning_auto_flag"),
    sql.indexOf("alter table public.user_warnings owner to postgres")
  );
  assert.doesNotMatch(behaviorSql, /public\.user_flag_cases/iu);
  assert.doesNotMatch(behaviorSql, /apply_website_ban|is_user_participation_held|participation_hold/iu);
});

test("all Warning tables and RPCs are owner-hardened, RLS-closed and service-only", () => {
  for (const table of [
    "user_warnings",
    "user_warning_current",
    "user_warning_events",
    "user_warning_requests",
    "user_warning_auto_flag_cases",
    "user_warning_auto_flag_events",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(sql, new RegExp(`alter table public\\.${table} owner to postgres`, "u"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table}`, "u"));
  }
  assert.match(sql, /set search_path = public, pg_temp/gu);
  assert.match(sql, /grant execute on function public\.issue_user_warning[\s\S]*to service_role/u);
  assert.match(sql, /grant execute on function public\.overrule_user_warning[\s\S]*to service_role/u);
  assert.match(sql, /USER_WARNING_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(sql, /USER_WARNING_TABLE_SECURITY_MISMATCH/u);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all) on table public\.user_warning/iu);
});
