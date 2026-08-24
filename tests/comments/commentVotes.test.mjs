import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [thread, client, service, voteRoute, viewerRoute, dto] = await Promise.all([
  readFile(new URL("../../app/components/comments/CommunityCommentThread.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../lib/comments/commentClient.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/comments/commentService.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/comments/[publicCommentId]/vote/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/comments/votes/viewer-state/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/comments/commentDto.ts", import.meta.url), "utf8"),
]);

test("public DTO exposes only separate counts and forces tombstones to hide them", () => {
  assert.match(dto, /voteCounts: \{ up: number; down: number \} \| null/u);
  assert.match(dto, /value\.tombstone === "author_deleted"[\s\S]*value\.voteCounts !== null/u);
  assert.doesNotMatch(dto, /netScore|voter|discordUserId|voteHistory/iu);
});

test("viewer state uses one bounded deduplicated batch path instead of per-Comment reads", () => {
  assert.match(client, /fetchCommunityCommentVoteViewerState/u);
  assert.match(client, /publicCommentIds: \[\.\.\.new Set\(publicCommentIds\)\]/u);
  assert.match(thread, /index \+= 100/u);
  assert.match(
    thread,
    /Promise\.all\(batches\.map\(\(ids\) => fetchCommunityCommentVoteViewerState\(ids\)\)\)/u,
  );
  assert.doesNotMatch(thread, /for \([^)]*comment[^)]*\)[\s\S]{0,160}await fetchCommunityCommentVoteViewerState/iu);
  assert.match(service, /input\.publicCommentIds\.length > COMMUNITY_COMMENT_BATCH_MAX_IDS/u);
  assert.match(viewerRoute, /Object\.keys\(body\)\.length !== 1/u);
});

test("viewer-state loading renders do not cancel their own in-flight batch", () => {
  const batchEffect = thread.slice(
    thread.indexOf("const accountGeneration = voteViewerAccountGeneration.current"),
    thread.indexOf("function applyPage"),
  );

  assert.match(thread, /const voteViewerAccountGeneration = useRef\(0\)/u);
  assert.match(batchEffect, /accountGeneration !== voteViewerAccountGeneration\.current/u);
  assert.doesNotMatch(batchEffect, /disposed/u);
  assert.doesNotMatch(batchEffect, /return \(\) =>/u);
});

test("Vote routes are thin Node handlers and require the hardened Website session", () => {
  for (const route of [voteRoute, viewerRoute]) {
    assert.match(route, /runtime = "nodejs"/u);
    assert.match(route, /dynamic = "force-dynamic"/u);
    assert.match(route, /requireSession\(\)/u);
    assert.doesNotMatch(route, /supabaseAdmin|\.from\(/u);
  }
  assert.match(voteRoute, /export async function PUT/u);
  assert.match(viewerRoute, /export async function POST/u);
});

test("server accepts desired end state, expected version and idempotency key only", () => {
  const voteService = service.slice(service.indexOf("export async function setCommunityCommentVote"));
  assert.match(voteService, /setCommunityCommentVote/u);
  assert.match(voteService, /input\.body\.desiredState === null/u);
  assert.match(voteService, /input\.body\.expectedVersion/u);
  assert.match(voteService, /input\.body\.requestId/u);
  assert.match(voteService, /exactKeys\(input\.body, \["desiredState", "expectedVersion", "requestId"\]\)/u);
  assert.match(voteService, /rpc\("set_community_comment_vote"/u);
  assert.match(voteService, /STALE_VOTE/u);
  assert.match(voteService, /IDEMPOTENCY_CONFLICT/u);
  assert.doesNotMatch(voteService, /participationHold|discordMembership|voterList|netScore/iu);
});

test("compact accessible UI supports toggle, switch, self-vote and local locking", () => {
  assert.match(thread, /aria-label="Upvote comment"/u);
  assert.match(thread, /aria-label="Downvote comment"/u);
  assert.match(thread, /function CommentVoteThumb/u);
  assert.match(thread, /function CommentVoteLayoutMenu/u);
  assert.match(thread, /type CommentVoteLayout = "thumbs" \| "expressive"/u);
  assert.match(thread, /useState<CommentVoteLayout>\("thumbs"\)/u);
  assert.match(thread, /direction === "up" \? "✌️" : "🖕"/u);
  assert.match(thread, /aria-label="Choose vote icons"/u);
  assert.match(thread, /window\.localStorage\.setItem\(COMMENT_VOTE_LAYOUT_STORAGE_KEY, nextLayout\)/u);
  assert.match(thread, /aria-pressed=\{voteViewer\.state === "up"\}/u);
  assert.match(thread, /voteViewer\.state === "up" \? null : "up"/u);
  assert.match(thread, /voteViewer\.state === "down" \? null : "down"/u);
  assert.match(thread, /voteBusyIds\.current\.has\(comment\.publicCommentId\)/u);
  assert.match(thread, /voteBusyIds\.current\.add\(comment\.publicCommentId\)/u);
  assert.match(thread, /disabled=\{account\.kind === "authenticated" && voteViewer\.loading\}/u);
  assert.doesNotMatch(thread, /comment\.author\.publicProfileId[\s\S]{0,120}canVote/u);
});

test("server receipts alone update counts and Top order stays untouched until refresh", () => {
  assert.match(thread, /voteCounts: receipt\.projection\.voteCounts/u);
  assert.match(thread, /version: receipt\.projection\.viewerVersion/u);
  assert.match(thread, /reason\.code === "STALE_VOTE"[\s\S]*fetchCommunityCommentsBatch\(\[comment\.publicCommentId\]\)/u);
  assert.match(thread, /fetchCommunityCommentVoteViewerState\(\[comment\.publicCommentId\]\)/u);
  assert.doesNotMatch(thread, /sort\([^)]*vote|netScore|up\s*-\s*down/iu);
});

test("read-only renders counts without mutation and tombstones render neither", () => {
  assert.match(thread, /const canVote =[\s\S]*canMutate/u);
  assert.match(thread, /voteCounts \?/u);
  assert.match(thread, /aria-label=\{`\$\{voteCounts\.up\} upvotes`\}/u);
  assert.match(thread, /comment\.tombstone === null/u);
  assert.match(thread, /setReleaseState\("read_only"\)/u);
});
