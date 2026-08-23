import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootRoute = await readFile(new URL("../../app/api/comments/submissions/[submissionId]/route.ts", import.meta.url), "utf8");
const replyRoute = await readFile(new URL("../../app/api/comments/submissions/[submissionId]/[rootPublicCommentId]/replies/route.ts", import.meta.url), "utf8");
const commentRoute = await readFile(new URL("../../app/api/comments/[publicCommentId]/route.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../../lib/comments/commentService.server.ts", import.meta.url), "utf8");
const abuse = await readFile(new URL("../../lib/comments/commentAbuse.server.ts", import.meta.url), "utf8");

test("public reads and authenticated writes stay in thin Node route handlers", () => {
  for (const route of [rootRoute, replyRoute, commentRoute]) {
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
    "get_community_comment_thread_page",
    "get_community_comment_replies",
    "get_community_comment_deep_link",
    "get_community_comments_batch",
    "create_community_comment_root",
    "create_community_comment_reply",
    "edit_community_comment",
    "delete_community_comment",
  ]) assert.ok(service.includes(`rpc("${rpc}"`), `${rpc} RPC must be used`);
});
