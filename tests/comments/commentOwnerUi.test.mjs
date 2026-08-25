import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("My Profile exposes five-item Comments and Mentions previews with full routes", async () => {
  const [page, sections] = await Promise.all([
    source("app/my-profile/page.tsx"),
    source("app/my-profile/ProfileSections.tsx"),
  ]);
  assert.match(page, /loadOwnComments\([\s\S]*limit: PROFILE_PREVIEW_LIMIT/u);
  assert.match(page, /loadOwnMentions\([\s\S]*limit: PROFILE_PREVIEW_LIMIT/u);
  assert.match(sections, /title="My Comments"/u);
  assert.match(sections, /href="\/my-profile\/comments"/u);
  assert.match(sections, /title="My Mentions"/u);
  assert.match(sections, /href="\/my-profile\/mentions"/u);
});

test("full owner routes are protected, dynamic, and paginate through bounded cursors", async () => {
  const [comments, mentions, service] = await Promise.all([
    source("app/my-profile/comments/page.tsx"),
    source("app/my-profile/mentions/page.tsx"),
    source("lib/comments/commentOwner.server.ts"),
  ]);
  for (const page of [comments, mentions]) {
    assert.match(page, /dynamic = "force-dynamic"/u);
    assert.match(page, /getSessionState\(\)/u);
    assert.match(page, /redirect\(`\/api\/auth\/discord\/login/u);
    assert.match(page, /after=\$\{encodeURIComponent\(page\.nextCursor\)\}/u);
  }
  assert.match(service, /const PAGE_SIZE = 20/u);
  assert.match(service, /allItems\.slice\(0, boundedLimit\)/u);
  assert.match(service, /parseCommentOwnerCursor\(cursor, "comments"\)/u);
  assert.match(service, /parseCommentOwnerCursor\(cursor, "mentions"\)/u);
});

test("Comment cards preserve text safely and provide neutral unavailable states", async () => {
  const component = await source("app/my-profile/CommentOwnerLists.tsx");
  assert.match(component, /whitespace-pre-wrap break-words/u);
  assert.match(component, /Comment deleted by its author/u);
  assert.match(component, /Comment removed by the Team/u);
  assert.match(component, /Comment destination no longer available/u);
  assert.match(component, /Open conversation/u);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/u);
});

test("Mention actions use expected versions, idempotency keys, and snapshot mark-all", async () => {
  const [component, viewRoute, dismissRoute, viewAllRoute] = await Promise.all([
    source("app/my-profile/CommentOwnerLists.tsx"),
    source("app/api/my-profile/mentions/[mentionId]/view/route.ts"),
    source("app/api/my-profile/mentions/[mentionId]/dismiss/route.ts"),
    source("app/api/my-profile/mentions/view-all/route.ts"),
  ]);
  assert.match(component, /crypto\.randomUUID\(\)/u);
  assert.match(component, /expectedVersion: item\.stateVersion/u);
  assert.match(component, /snapshotAt: page\.snapshotAt/u);
  assert.match(component, /Mark all shown by this snapshot as viewed/u);
  assert.match(component, /Hide this mention from My Mentions/u);
  for (const route of [viewRoute, dismissRoute, viewAllRoute]) {
    assert.match(route, /enforceRouteMutationGate\(\)/u);
    assert.match(route, /requireSameOrigin\(request\)/u);
    assert.match(route, /Object\.keys\(body\)\.length !== 2/u);
    assert.match(route, /INVALID_ORIGIN/u);
  }
});

test("owner DTO validation rejects internal identifiers and non-neutral tombstones", async () => {
  const service = await source("lib/comments/commentOwner.server.ts");
  assert.doesNotMatch(service, /discordUserId|submissionId|commentId:/u);
  assert.match(service, /status !== "available" && \(item\.body !== null \|\| item\.destinationHref !== null\)/u);
  assert.match(service, /safeDestination/u);
});
