import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootRoute = await readFile(new URL("../../app/api/comments/submissions/[submissionId]/route.ts", import.meta.url), "utf8");
const replyRoute = await readFile(new URL("../../app/api/comments/submissions/[submissionId]/[rootPublicCommentId]/replies/route.ts", import.meta.url), "utf8");
const commentRoute = await readFile(new URL("../../app/api/comments/[publicCommentId]/route.ts", import.meta.url), "utf8");
const countRoute = await readFile(new URL("../../app/api/comments/counts/route.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../../lib/comments/commentService.server.ts", import.meta.url), "utf8");
const abuse = await readFile(new URL("../../lib/comments/commentAbuse.server.ts", import.meta.url), "utf8");
const releaseStateProjection = await readFile(new URL("../../supabase/migrations/20260823000500_comment_release_state_projection.sql", import.meta.url), "utf8");

test("public reads and authenticated writes stay in thin Node route handlers", () => {
  for (const route of [rootRoute, replyRoute, commentRoute, countRoute]) {
    assert.match(route, /runtime = "nodejs"/u);
    assert.match(route, /dynamic = "force-dynamic"/u);
    assert.doesNotMatch(route, /supabaseAdmin|\.from\(/u);
  }
  assert.match(rootRoute, /export async function GET/u);
  assert.ok(rootRoute.indexOf("requireSession()") < rootRoute.indexOf("createCommunityCommentRoot("));
  assert.ok(replyRoute.indexOf("requireSession()") < replyRoute.indexOf("createCommunityCommentReply("));
  assert.ok(commentRoute.indexOf("requireSession()") < commentRoute.indexOf("editCommunityComment("));
});

test("server owns eligibility, HMAC abuse digest, fresh Turnstile and exact RPC boundaries", () => {
  assert.match(abuse, /COMMENT_ABUSE_HMAC_SECRET/u);
  assert.match(service, /TURNSTILE_ACTIONS\.communityComment/u);
  assert.match(service, /maxTokenAgeMs: COMMENT_TURNSTILE_MAX_AGE_MS/u);
  assert.doesNotMatch(service, /remoteip|ipAddress|deviceId|discordMembership|participationHold/iu);
  for (const rpc of [
    "get_community_comment_thread_page_v2",
    "get_community_comment_counts",
    "get_community_comment_replies",
    "get_community_comment_deep_link",
    "get_community_comments_batch",
    "create_community_comment_root",
    "create_community_comment_reply",
    "edit_community_comment",
    "delete_community_comment",
  ]) assert.ok(service.includes(`rpc("${rpc}"`), `${rpc} RPC must be used`);
  assert.match(countRoute, /getCommunityCommentCounts/u);
  assert.match(countRoute, /submissionIds/u);
});

test("root reads expose the server-authoritative mutation availability without weakening ACLs", () => {
  assert.match(service, /releaseState: value\.releaseState as "read_only" \| "open"/u);
  assert.match(service, /\["read_only", "open"\]\.includes\(String\(value\.releaseState\)\)/u);
  assert.match(releaseStateProjection, /'releaseState', v_release_state/gu);
  assert.match(releaseStateProjection, /v_release_state = 'off'/u);
  assert.match(releaseStateProjection, /revoke all on function public\.get_community_comment_thread_page[\s\S]*from public, anon, authenticated, discord_bot, service_role/iu);
  assert.match(releaseStateProjection, /grant execute on function public\.get_community_comment_thread_page[\s\S]*to service_role/iu);
  assert.doesNotMatch(releaseStateProjection, /grant execute on function public\.get_community_comment_release_state/iu);
});
