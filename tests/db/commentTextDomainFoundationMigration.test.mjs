import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [sql, correctionSql, topAliasCorrectionSql, devContract, concurrencyContract, postflightContract] = await Promise.all([
  readFile(new URL("../../supabase/migrations/20260823000200_comment_text_domain_foundation.sql", import.meta.url), "utf8"),
  readFile(new URL("../../supabase/migrations/20260823000300_comment_digest_schema_qualification.sql", import.meta.url), "utf8"),
  readFile(new URL("../../supabase/migrations/20260823000400_comment_top_cursor_alias_correction.sql", import.meta.url), "utf8"),
  readFile(new URL("./commentTextDomainFoundation.dev.sql", import.meta.url), "utf8"),
  readFile(new URL("./commentTextDomainConcurrency.dev.mjs", import.meta.url), "utf8"),
  readFile(new URL("./commentTextDomainPostflight.dev.sql", import.meta.url), "utf8"),
]);

test("foundation is additive, guarded, globally off, and contains no public abuse thresholds", () => {
  assert.match(sql, /^begin;/u);
  assert.match(sql, /COMMUNITY_COMMENT_TEXT_FOUNDATION_BASELINE_MISMATCH/u);
  assert.match(sql, /values \(true, 'off'\)/u);
  assert.match(sql, /release_state in \('off', 'read_only', 'open'\)/u);
  assert.doesNotMatch(sql, /insert into public\.community_comment_abuse_policies/u);
  assert.doesNotMatch(sql, /raw_ip|ip_address|device_identifier|device_id/iu);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/iu);
  assert.match(sql, /commit;\s*$/u);
});

test("canonical identities, immutable versions, mentions, requests, and receipts are separate", () => {
  assert.match(sql, /id uuid primary key default gen_random_uuid\(\)[\s\S]*public_comment_id uuid not null unique default gen_random_uuid\(\)/u);
  for (const table of [
    "community_comment_text_versions",
    "community_comment_mention_lifecycle",
    "community_comment_mentions",
    "community_comment_mutation_events",
    "community_comment_mutation_requests",
  ]) assert.match(sql, new RegExp(`create table public\\.${table}`, "u"));
  assert.match(sql, /COMMUNITY_COMMENT_HISTORY_IS_APPEND_ONLY/u);
  assert.match(sql, /primary key \(actor_discord_user_id, request_id\)/u);
  assert.match(sql, /receipt jsonb not null/u);
});

test("reads fix page sizes, previews, batch semantics, deep-link window and fail-closed eligibility", () => {
  assert.match(sql, /p_limit not between 1 and 20/g);
  assert.match(sql, /limit 3/u);
  assert.match(sql, /windowLimit', 20/u);
  assert.match(sql, /cardinality\(p_public_comment_ids\) > 100/u);
  assert.match(sql, /cycle\.status = 'finished'/u);
  assert.match(sql, /submission\.public_visibility_status = 'visible'/u);
  assert.match(sql, /coalesce\(submission\.is_disqualified, false\) = false/u);
  assert.doesNotMatch(sql, /feed_eligible|vote_count\s*>|is_in_discord|participation_hold|joined_at/iu);
});

test("writes use session eligibility, database time, locks, versions and irreversible root closure", () => {
  assert.match(sql, /require_account_session\(p_session_id\)/u);
  assert.match(sql, /transaction_timestamp\(\)/u);
  assert.match(sql, /for update/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /interval '15 minutes'/u);
  assert.match(sql, /'branch_closed'/u);
  assert.match(sql, /old\.author_deleted_at is not null and new\.author_deleted_at is null/u);
  assert.doesNotMatch(sql, /is_in_discord|participation_hold|join_cooldown|joined_at/iu);
});

test("public DTO and exact RLS ACL boundaries exclude internal history and identity", () => {
  const projection = sql.slice(sql.indexOf("create function public.build_community_comment_public_json"), sql.indexOf("create function public.get_community_comment_thread_page"));
  assert.match(projection, /'publicProfileId'/u);
  assert.match(projection, /'displayName'/u);
  assert.match(projection, /'isCreator'/u);
  assert.match(projection, /'isBanned'/u);
  assert.doesNotMatch(projection, /discordUserId|banReason|previous|oldBody|report/iu);
  assert.match(sql, /COMMUNITY_COMMENT_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(sql, /COMMUNITY_COMMENT_TABLE_SECURITY_MISMATCH/u);
  assert.match(sql, /owner to postgres/u);
  assert.match(sql, /set search_path = public, pg_temp/u);
  assert.doesNotMatch(sql, /grant (select|insert|update|delete|all).*community_comment/iu);
});

test("rollback-only DEV contract covers replay, stale writers, lifecycle, privacy and release states", () => {
  for (const boundary of [
    "COMMUNITY_COMMENTS_DEV_ANONYMOUS_ZERO_VOTE_READ_FAILED",
    "COMMUNITY_COMMENTS_DEV_EXTERNAL_LINK_ACCEPTED",
    "COMMUNITY_COMMENTS_DEV_STABLE_REPLAY_FAILED",
    "COMMUNITY_COMMENTS_DEV_IDEMPOTENCY_CONFLICT_FAILED",
    "COMMUNITY_COMMENTS_DEV_STALE_THREAD_FAILED",
    "COMMUNITY_COMMENTS_DEV_REPLY_PREVIEW_FAILED",
    "COMMUNITY_COMMENTS_DEV_APPEND_ONLY_LIFECYCLE_FAILED",
    "COMMUNITY_COMMENTS_DEV_STALE_EDIT_FAILED",
    "COMMUNITY_COMMENTS_DEV_TOMBSTONE_FAILED",
    "COMMUNITY_COMMENTS_DEV_DELETED_ROOT_BRANCH_OPEN",
    "COMMUNITY_COMMENTS_DEV_BANNED_SESSION_NOT_REJECTED",
    "COMMUNITY_COMMENTS_DEV_READ_ONLY_WRITE_ACCEPTED",
    "COMMUNITY_COMMENTS_DEV_OFF_READ_ACCEPTED",
  ]) assert.match(devContract, new RegExp(boundary, "u"));
  assert.match(devContract, /^\\set ON_ERROR_STOP on[\s\S]*begin;[\s\S]*rollback;\s*$/u);
});

test("digest correction is additive, exact, and preserves every hardened boundary", () => {
  assert.match(correctionSql, /^begin;/u);
  assert.match(correctionSql, /COMMUNITY_COMMENT_DIGEST_CORRECTION_BASELINE_MISMATCH/u);
  assert.match(correctionSql, /extensions\.digest\(/u);
  assert.match(correctionSql, /pg_get_functiondef/u);
  assert.match(correctionSql, /search_path=public, pg_temp/u);
  assert.match(correctionSql, /pg_get_userbyid\(function_row\.proowner\) = 'postgres'/u);
  assert.match(correctionSql, /COMMUNITY_COMMENT_DIGEST_CORRECTION_POSTFLIGHT_MISMATCH/u);
  assert.match(correctionSql, /COMMUNITY_COMMENT_DIGEST_CORRECTION_SECURITY_MISMATCH/u);
  assert.doesNotMatch(correctionSql, /grant execute|alter table|insert into|delete from|truncate|drop /iu);
  assert.match(correctionSql, /commit;\s*$/u);
});

test("Top cursor correction replaces only the invalid same-level alias", () => {
  assert.match(topAliasCorrectionSql, /^begin;/u);
  assert.match(topAliasCorrectionSql, /COMMUNITY_COMMENT_TOP_ALIAS_CORRECTION_BASELINE_MISMATCH/u);
  assert.match(topAliasCorrectionSql, /then net_score end desc/u);
  assert.match(topAliasCorrectionSql, /then 0 end desc/u);
  assert.match(topAliasCorrectionSql, /pg_get_functiondef/u);
  assert.match(topAliasCorrectionSql, /search_path=public, pg_temp/u);
  assert.match(topAliasCorrectionSql, /COMMUNITY_COMMENT_TOP_ALIAS_CORRECTION_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(topAliasCorrectionSql, /grant execute|alter table|insert into|delete from|truncate|drop /iu);
  assert.match(topAliasCorrectionSql, /commit;\s*$/u);
});

test("DEV concurrency contract uses independent transactions and leaves fail-closed state", () => {
  assert.match(concurrencyContract, /Promise\.all\(statements\.map/u);
  assert.match(concurrencyContract, /pg_advisory_xact_lock\(hashtextextended/u);
  assert.match(concurrencyContract, /for update/u);
  assert.match(concurrencyContract, /rollback;/u);
  assert.match(concurrencyContract, /off\|0\|0\|0/u);
  assert.doesNotMatch(concurrencyContract, /insert into|update public|delete from|truncate|drop /iu);
});

test("DEV postflight rechecks state, RLS, ACL, owner, search path and overloads read-only", () => {
  for (const boundary of [
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_STATE_DRIFT",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_TABLE_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_INVOKER_ACL_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_OVERLOAD_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_DIGEST_MISMATCH",
    "COMMUNITY_COMMENTS_DEV_POSTFLIGHT_TOP_SORT_MISMATCH",
  ]) assert.match(postflightContract, new RegExp(boundary, "u"));
  assert.match(postflightContract, /begin read only;/u);
  assert.match(postflightContract, /rollback;\s*$/u);
});
