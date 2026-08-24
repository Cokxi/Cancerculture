import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [sql, replayPrivacySql, devContract, concurrencyContract, postflightContract] = await Promise.all([
  readFile(new URL("../../supabase/migrations/20260824000100_atomic_comment_votes.sql", import.meta.url), "utf8"),
  readFile(new URL("../../supabase/migrations/20260824000200_comment_vote_replay_privacy.sql", import.meta.url), "utf8"),
  readFile(new URL("./atomicCommentVotes.dev.sql", import.meta.url), "utf8"),
  readFile(new URL("./atomicCommentVotesConcurrency.dev.mjs", import.meta.url), "utf8"),
  readFile(new URL("./atomicCommentVotesPostflight.dev.sql", import.meta.url), "utf8"),
]);

test("atomic Comment Votes are additive, fail-closed and publish no real thresholds", () => {
  assert.match(sql, /^begin;/u);
  assert.match(sql, /ATOMIC_COMMENT_VOTES_BASELINE_MISMATCH/u);
  assert.doesNotMatch(sql, /insert into public\.community_comment_abuse_policies/u);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/iu);
  assert.match(sql, /commit;\s*$/u);
});

test("current relation, append-only transitions and receipts stay identity-private", () => {
  for (const table of [
    "community_comment_votes",
    "community_comment_vote_transitions",
    "community_comment_vote_requests",
  ]) assert.match(sql, new RegExp(`create table public\\.${table}`, "u"));
  assert.match(sql, /primary key \(comment_id, voter_discord_user_id\)/u);
  assert.match(sql, /community_comment_vote_transitions_no_update[\s\S]*protect_community_comment_append_only/u);
  assert.match(sql, /receipt jsonb not null/u);
  assert.doesNotMatch(sql, /'discordUserId'|'voterIds'|'netScore'\s*,\s*public/iu);
});

test("mutation uses Website session, pair locks, versions, replay and database time", () => {
  assert.match(sql, /require_account_session\(p_session_id\)/u);
  assert.match(sql, /community-comment-vote:' \|\| v_actor/u);
  assert.match(sql, /community-comment-vote-request:/u);
  assert.match(sql, /v_current_version <> p_expected_version/u);
  assert.match(sql, /'stale_vote'/u);
  assert.match(sql, /'idempotency_conflict'/u);
  assert.match(sql, /transaction_timestamp\(\)/u);
  assert.match(sql, /for share/u);
  assert.doesNotMatch(sql, /is_in_discord|participation_hold|joined_at/iu);
});

test("Top reads derive an as-of score while Newest and Replies remain separate", () => {
  assert.match(sql, /get_community_comment_vote_score_at\(comment_row\.id, v_snapshot_at\)/u);
  assert.match(sql, /transition\.transitioned_at <= p_snapshot_at/u);
  assert.match(sql, /ranked\.net_score < p_after_score/u);
  assert.match(sql, /case when p_sort = 'top' then v_last_score else null end/u);
  assert.doesNotMatch(sql, /create or replace function public\.get_community_comment_replies/iu);
});

test("viewer state is deduplicated, bounded to 100 and omits ineligible tombstones", () => {
  assert.match(sql, /cardinality\(p_public_comment_ids\) > 100/u);
  assert.match(sql, /group by public_id/u);
  assert.match(sql, /comment_row\.author_deleted_at is null/u);
  assert.match(sql, /is_community_comment_submission_eligible/u);
  assert.doesNotMatch(sql, /ban_reason|ip_address|device_identifier|report/iu);
});

test("replay privacy correction hides old receipts after tombstones or lost eligibility", () => {
  assert.match(replayPrivacySql, /^begin;/u);
  assert.match(replayPrivacySql, /COMMENT_VOTE_REPLAY_PRIVACY_BASELINE_MISMATCH/u);
  assert.match(replayPrivacySql, /v_comment\.author_deleted_at is not null/u);
  assert.match(replayPrivacySql, /is_community_comment_submission_eligible\(v_comment\.submission_id\)/u);
  assert.match(replayPrivacySql, /'comment_unavailable'/u);
  assert.match(replayPrivacySql, /COMMENT_VOTE_REPLAY_PRIVACY_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(replayPrivacySql, /grant execute|alter table|insert into|delete from|truncate|drop /iu);
  assert.match(replayPrivacySql, /commit;\s*$/u);
});

test("rollback DEV contract covers transitions, privacy, snapshot stability and release states", () => {
  for (const boundary of [
    "ATOMIC_COMMENT_VOTES_DEV_NEUTRAL_TO_UP_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_UP_TO_NEUTRAL_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_UP_TO_DOWN_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_DOWN_TO_UP_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_REPLAY_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_IDEMPOTENCY_CONFLICT_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_STALE_VERSION_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_INDEPENDENT_USERS_COUNTS_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_VIEWER_BATCH_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_SNAPSHOT_STABILITY_FAILED",
    "ATOMIC_COMMENT_VOTES_DEV_NEWEST_ORDER_CHANGED",
    "ATOMIC_COMMENT_VOTES_DEV_REPLY_ORDER_CHANGED",
    "ATOMIC_COMMENT_VOTES_DEV_BANNED_SESSION_ACCEPTED",
    "ATOMIC_COMMENT_VOTES_DEV_TOMBSTONE_VOTE_ACCEPTED",
    "ATOMIC_COMMENT_VOTES_DEV_TOMBSTONE_REPLAY_EXPOSED",
    "ATOMIC_COMMENT_VOTES_DEV_READ_ONLY_WRITE_ACCEPTED",
    "ATOMIC_COMMENT_VOTES_DEV_OFF_VIEWER_ACCEPTED",
  ]) assert.match(devContract, new RegExp(boundary, "u"));
  assert.match(devContract, /^\\set ON_ERROR_STOP on[\s\S]*begin;[\s\S]*rollback;\s*$/u);
});

test("concurrency and read-only postflight prove exact lock and security boundaries", () => {
  assert.match(concurrencyContract, /samePairMs/u);
  assert.match(concurrencyContract, /independentMs/u);
  assert.match(concurrencyContract, /Promise\.all/u);
  assert.match(concurrencyContract, /off\|1\|0\|0\|0\|0\|0\|0/u);
  for (const boundary of [
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_STATE_DRIFT",
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_TABLE_MISMATCH",
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH",
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH",
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_OVERLOAD_MISMATCH",
    "ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_DEFINITION_MISMATCH",
  ]) assert.match(postflightContract, new RegExp(boundary, "u"));
  assert.match(postflightContract, /begin read only;/u);
});
