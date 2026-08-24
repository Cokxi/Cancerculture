import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mergeCommunityComments,
  parseCommunityCommentRootPage,
} from "../../lib/comments/commentClient.ts";

const id = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
const replyId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18423";
const authorId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18424";
const baseComment = {
  publicCommentId: id,
  submissionId: 12,
  rootPublicCommentId: null,
  replyTargetPublicCommentId: null,
  version: 1,
  createdAt: "2026-08-23T12:00:00.000Z",
  edited: false,
  editedAt: null,
  tombstone: null,
  body: "Hello 😀",
  author: {
    publicProfileId: authorId,
    displayName: "Ada",
    isCreator: true,
    isBanned: false,
  },
  mentions: [],
  replyCount: 0,
  voteCounts: { up: 0, down: 0 },
};

const [thread, composer, client, feed, detail, history, fame, shame, accountRoute] =
  await Promise.all([
    readFile(new URL("../../app/components/comments/CommunityCommentThread.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/components/comments/CommunityCommentComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../lib/comments/commentClient.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/spread/CommunityFeedClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/spread/[submissionId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/cycle-history/CycleHistoryClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/wall/fame/FameGrid.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/wall/shame/ShameGrid.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/auth/account/route.ts", import.meta.url), "utf8"),
  ]);

test("root-page client parser requires the exact server-authoritative release state", () => {
  const page = {
    releaseState: "read_only",
    submissionId: 12,
    sort: "top",
    snapshotAt: "2026-08-23T12:00:00.000Z",
    threadVersion: 0,
    items: [{ ...baseComment, replyPreview: [], replyPreviewHasMore: false }],
    hasMore: false,
    nextCursor: null,
  };
  assert.equal(parseCommunityCommentRootPage(page, 12, "top").releaseState, "read_only");
  assert.equal(parseCommunityCommentRootPage({ ...page, releaseState: "open" }, 12, "top").releaseState, "open");
  for (const releaseState of [undefined, "off", "OPEN", true]) {
    assert.throws(() => parseCommunityCommentRootPage({ ...page, releaseState }, 12, "top"), {
      message: "COMMENTS_UNAVAILABLE",
    });
  }
  assert.throws(() => parseCommunityCommentRootPage({ ...page, discordUserId: "private" }, 12, "top"));
});

test("reply merges deduplicate public IDs and remain chronological beyond preview windows", () => {
  const later = {
    ...baseComment,
    publicCommentId: replyId,
    rootPublicCommentId: id,
    replyTargetPublicCommentId: id,
    createdAt: "2026-08-23T12:02:00.000Z",
  };
  const earlier = {
    ...later,
    publicCommentId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18425",
    createdAt: "2026-08-23T12:01:00.000Z",
  };
  assert.deepEqual(
    mergeCommunityComments([later], [earlier, later]).map((item) => item.publicCommentId),
    [earlier.publicCommentId, later.publicCommentId],
  );
  assert.doesNotMatch(client, /slice\(0,\s*100\)|replyCount\s*[<>]=?\s*100/u);
});

test("one reusable thread integrates all four finalized public surfaces and excludes Live", () => {
  for (const source of [feed, detail, history, fame, shame]) {
    assert.match(source, /CommunityCommentThread/u);
  }
  assert.match(feed, /feed !== "live"/u);
  assert.match(detail, /detail\.state === "finalized"/u);
  assert.match(history, /!submission\.isDisqualified[\s\S]*SUBMISSION_PUBLIC_VISIBILITY\.visible/u);
  assert.match(fame, /SUBMISSION_PUBLIC_VISIBILITY\.visible/u);
  assert.match(shame, /SUBMISSION_PUBLIC_VISIBILITY\.visible/u);
  assert.match(thread, /data-comment-submission-id=\{submissionId\}/u);
  assert.doesNotMatch(thread, /surface|feedKind|wallKind|cycleId/u);
});

test("reader supports signed cursors, bounded deep links, refresh snapshots and one-level Replies", () => {
  assert.match(client, /cursor=.*encodeURIComponent\(input\.cursor\)/u);
  assert.match(client, /windowLimit !== 20/u);
  assert.match(thread, /params\.get\("comment"\)/u);
  assert.match(thread, /fetchCommunityCommentDeepLink\(targetId\)/u);
  assert.match(thread, /New comments or replies may be available/u);
  assert.match(thread, /expanded: false/u);
  assert.match(thread, /branch\.expanded &&/u);
  assert.match(thread, /View \$\{comment\.replyCount\}/u);
  assert.match(thread, /View \$\{remainingReplies\} more/u);
  assert.doesNotMatch(thread, /View earlier replies/u);
  assert.match(thread, /mergeCommunityComments/u);
  assert.match(thread, /Replying to @\{replyTargetName\}/u);
});

test("composer preserves structured stable Mentions, Unicode limits and challenge retries", () => {
  assert.match(composer, /searchCommunityCommentMentions\(query\.query\)/u);
  assert.match(composer, /targetPublicProfileId/u);
  assert.match(composer, /codePointLength/u);
  assert.match(composer, /new TextEncoder\(\)\.encode\(body\)\.byteLength/u);
  assert.match(composer, /characterCount >= 9_000 \|\| byteCount >= 36_000/u);
  assert.match(composer, /TURNSTILE_REQUIRED/u);
  assert.match(composer, /Your text is still here/u);
  assert.match(composer, /busyRef\.current/u);
  assert.match(composer, /reconcileMentions\(body, nextBody, current\)\.filter/u);
  assert.match(composer, /const statusId = useId\(\)/u);
  assert.match(composer, /textareaRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(composer, /textareaRef\.current\?\.scrollIntoView/u);
  assert.doesNotMatch(composer, /dangerouslySetInnerHTML|contentEditable/u);
});

test("server-confirmed create, edit and irreversible delete receipts drive visible state", () => {
  assert.match(thread, /Your new comment/u);
  assert.match(thread, /expectedThreadVersion: page\.threadVersion/u);
  assert.match(thread, /expectedRootVersion: branch\.rootVersion/u);
  assert.match(thread, /expectedRootVersion: ownNewBranch\.rootVersion/u);
  assert.match(thread, /expectedTargetVersion: replyTarget\.target\.version/u);
  assert.match(thread, /expectedVersion: comment\.version/u);
  assert.match(thread, /confirmed: true/u);
  assert.match(thread, /version: receipt\.rootVersion \?\? item\.version/u);
  assert.match(thread, /Comment deleted by its author/u);
  assert.match(thread, /Permanently delete this comment\?/u);
  assert.doesNotMatch(thread, /oldBody|previousBody|versionHistory|discordUserId|banReason/u);
});

test("read-only and off states fail closed while own actions use only the private account view", () => {
  assert.match(thread, /reason\.code === "READ_ONLY"[\s\S]*setReleaseState\("read_only"\)/u);
  assert.match(thread, /reason\.status === 404[\s\S]*setHidden\(true\)/u);
  assert.match(thread, /releaseState === "read_only"/u);
  assert.match(accountRoute, /public_profile_id/u);
  assert.match(accountRoute, /Cache-Control": "no-store"/u);
  assert.match(thread, /account\.publicProfileId === comment\.author\.publicProfileId/u);
});

test("Comment controls retain keyboard targets, live status and accessible confirmation", () => {
  assert.match(thread, /role="alertdialog"/u);
  assert.match(thread, /aria-modal="true"/u);
  assert.match(thread, /confirmRef\.current\?\.focus\(\)/u);
  assert.match(thread, /const titleId = useId\(\)/u);
  assert.match(thread, /account\.kind === "authenticated" \|\| account\.kind === "anonymous"/u);
  assert.match(thread, /key=\{`reply:\$\{replyTarget\.target\.publicCommentId\}:[\s\S]*autoFocus/u);
  assert.match(thread, /ml-auto flex items-center/u);
  assert.match(thread, /\[&_button:not\(:disabled\)\]:cursor-pointer/u);
  assert.match(thread, /min-h-11/gu);
  assert.match(thread, /focus-visible:ring-2/gu);
  assert.match(composer, /aria-label="Mention suggestions"/u);
  assert.match(composer, /role="alert"/u);
  assert.match(thread, /min-w-0/u);
});
