import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, devConcurrency] = await Promise.all([
  readFile(
    new URL("../../supabase/migrations/20260824000800_comment_append_concurrency_correction.sql", import.meta.url),
    "utf8",
  ),
  readFile(new URL("./commentAppendConcurrency.dev.mjs", import.meta.url), "utf8"),
]);
const rootFunction = migration.slice(
  migration.indexOf("create or replace function public.create_community_comment_root"),
  migration.indexOf("create or replace function public.create_community_comment_reply"),
);
const replyFunction = migration.slice(
  migration.indexOf("create or replace function public.create_community_comment_reply"),
  migration.indexOf("alter function public.create_community_comment_root"),
);

test("append correction is additive, release-closed and reapply-guarded", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /release_state[\s\S]*<> 'off'/u);
  assert.match(migration, /COMMENT_APPEND_CONCURRENCY_BASELINE_MISMATCH/u);
  assert.match(migration, /COMMENT_APPEND_CONCURRENCY_FUNCTION_BASELINE_MISMATCH/u);
  assert.match(migration, /COMMENT_APPEND_CONCURRENCY_POSTFLIGHT_MISMATCH/u);
  assert.doesNotMatch(migration, /drop table|drop column|truncate/iu);
  assert.match(migration, /commit;\s*$/u);
});

test("independent Roots serialize and append without stale-snapshot rejection", () => {
  const appendHash = rootFunction.slice(
    rootFunction.indexOf("v_hash := encode"),
    rootFunction.indexOf("v_legacy_hash := encode"),
  );
  assert.doesNotMatch(appendHash, /expectedThreadVersion/u);
  assert.doesNotMatch(rootFunction, /v_thread\.version <> p_expected_thread_version/u);
  assert.match(rootFunction, /community-comment-request:/u);
  assert.match(rootFunction, /community_comment_threads[\s\S]*for update/u);
  assert.match(rootFunction, /set version = version \+ 1/u);
  assert.match(rootFunction, /v_request\.request_hash not in \(v_hash, v_legacy_hash\)/u);
  assert.ok(
    rootFunction.indexOf("return v_request.receipt") <
      rootFunction.indexOf("apply_community_comment_abuse_budget"),
    "stable replay must return before consuming another abuse budget",
  );
});

test("Replies lock current branch and target state without append-version conflicts", () => {
  const appendHash = replyFunction.slice(
    replyFunction.indexOf("v_hash := encode"),
    replyFunction.indexOf("v_legacy_hash := encode"),
  );
  assert.doesNotMatch(appendHash, /expectedRootVersion|expectedTargetVersion/u);
  assert.doesNotMatch(replyFunction, /v_root\.object_version <> p_expected_root_version/u);
  assert.doesNotMatch(replyFunction, /v_target\.object_version <> p_expected_target_version/u);
  assert.match(replyFunction, /id = any\(array\[v_root\.id, v_target\.id\]\)[\s\S]*for update/u);
  assert.match(replyFunction, /v_root\.team_removed_at is not null/u);
  assert.match(replyFunction, /v_target\.team_removed_at is not null/u);
  assert.match(replyFunction, /is_community_comment_submission_eligible/u);
  assert.match(replyFunction, /community_comment_threads[\s\S]*for update/u);
  assert.ok(
    replyFunction.indexOf("return v_request.receipt") <
      replyFunction.indexOf("apply_community_comment_abuse_budget"),
    "stable replay must return before consuming another abuse budget",
  );
});

test("both append paths retain one receipt, one mutation event and service-only ACLs", () => {
  for (const source of [rootFunction, replyFunction]) {
    assert.equal((source.match(/insert into public\.community_comment_mutation_requests/gu) ?? []).length, 1);
    assert.equal((source.match(/insert into public\.community_comment_mutation_events/gu) ?? []).length, 1);
    assert.match(source, /transaction_timestamp\(\)/u);
    assert.match(source, /extensions\.digest\(/u);
  }
  assert.match(migration, /revoke all on function public\.create_community_comment_root[\s\S]*from public, anon, authenticated, discord_bot, service_role/iu);
  assert.match(migration, /grant execute on function public\.create_community_comment_root[\s\S]*to service_role/iu);
  assert.match(migration, /revoke all on function public\.create_community_comment_reply[\s\S]*from public, anon, authenticated, discord_bot, service_role/iu);
  assert.match(migration, /grant execute on function public\.create_community_comment_reply[\s\S]*to service_role/iu);
});

test("DEV acceptance requires ten parallel Roots and Replies plus exact-once conflict evidence", () => {
  assert.match(devConcurrency, /Array\.from\(\{ length: 10 \}/gu);
  assert.match(devConcurrency, /Promise\.all\(rootInputs\.map/u);
  assert.match(devConcurrency, /Promise\.all\(replyInputs\.map/u);
  assert.match(devConcurrency, /rootReplays/u);
  assert.match(devConcurrency, /replyReplays/u);
  assert.match(devConcurrency, /scoped\.requests !== 20/u);
  assert.match(devConcurrency, /after\.abuseAppendEvents - before\.abuseAppendEvents !== 20/u);
  assert.match(devConcurrency, /after\.spamEvents !== before\.spamEvents/u);
  assert.match(devConcurrency, /staleEdit\.outcome !== "stale_comment"/u);
  assert.match(devConcurrency, /closedReply\.outcome !== "branch_closed"/u);
  assert.match(devConcurrency, /finalState\.releaseState !== "off"/u);
  assert.doesNotMatch(devConcurrency, /SUPABASE_LIVE_DATABASE_URL|nrxfuvsfezfqcwfmpxxl/u);
});
