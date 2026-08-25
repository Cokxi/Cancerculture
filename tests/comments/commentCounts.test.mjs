import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, service, client, thread] = await Promise.all([
  readFile(new URL("../../supabase/migrations/20260825000300_community_comment_total_counts.sql", import.meta.url), "utf8"),
  readFile(new URL("../../lib/comments/commentService.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/comments/commentClient.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/comments/CommunityCommentThread.tsx", import.meta.url), "utf8"),
]);

test("Comment totals use bounded service-only server projections", () => {
  assert.match(migration, /create function public\.get_community_comment_counts\(/u);
  assert.match(migration, /cardinality\(p_submission_ids\) not between 1 and 100/u);
  assert.match(migration, /count\(distinct submission_id\)/u);
  assert.match(migration, /is_community_comment_submission_eligible/u);
  assert.match(migration, /count\(comment_row\.id\)::bigint as total_count/u);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/iu);
  assert.match(migration, /revoke all on function public\.get_community_comment_counts[\s\S]*from public, anon, authenticated, discord_bot, service_role/iu);
  assert.match(migration, /grant execute on function public\.get_community_comment_counts[\s\S]*to service_role/iu);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon|grant execute[\s\S]*to authenticated/iu);
});

test("Root pages expose a snapshot-bound Roots-plus-Replies total", () => {
  assert.match(migration, /get_community_comment_thread_page_v2/u);
  assert.match(migration, /comment_row\.created_at <= v_snapshot_at/u);
  assert.match(migration, /jsonb_build_object\('totalCount', v_total_count\)/u);
  assert.match(service, /rpc\("get_community_comment_thread_page_v2"/u);
  assert.match(service, /totalCount: value\.totalCount/u);
  assert.match(client, /"totalCount"/u);
  assert.match(client, /totalCount: page\.totalCount as number/u);
});

test("Shared disclosures batch mounted Submission counts and reconcile appends", () => {
  assert.match(client, /fetch\("\/api\/comments\/counts"/u);
  assert.match(thread, /pendingCommentCountIds/u);
  assert.match(thread, /slice\(0, 100\)/u);
  assert.match(thread, /subscribeCommunityCommentCount/u);
  assert.match(thread, /queueCommunityCommentCountRefresh\(submissionId\)/gu);
  assert.match(thread, /totalCount: current\.totalCount \+ 1/gu);
  assert.match(thread, /publishCommunityCommentCount\(submissionId, page\.totalCount\)/u);
});
