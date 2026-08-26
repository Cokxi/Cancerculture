import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CommunityCommentClientError,
  fetchCommunityCommentModerationTarget,
  parseCommunityCommentAccountState,
  parseCommunityCommentModerationReviewContext,
  sendCommunityCommentModeration,
} from "../../lib/comments/commentClient.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [accountRoute, caseDetail, claimHoldMigration, client, menu, moderationService, moderationRoute, reviewCorrection, reviewMigration, thread] =
  await Promise.all([
    read("app/api/auth/account/route.ts"),
    read("app/components/teamInbox/TeamInboxCaseDetail.tsx"),
    read("supabase/migrations/20260826000300_comment_claimed_review_hold.sql"),
    read("lib/comments/commentClient.ts"),
    read("app/components/comments/CommunityCommentInlineModerationMenu.tsx"),
    read("lib/comments/commentModeration.server.ts"),
    read("app/api/admin/comments/moderation/route.ts"),
    read("supabase/migrations/20260826000200_comment_moderation_review_context_acl_correction.sql"),
    read("supabase/migrations/20260826000100_comment_moderation_review_context.sql"),
    read("app/components/comments/CommunityCommentThread.tsx"),
  ]);

const publicCommentId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
const publicProfileId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18424";
const publicComment = {
  publicCommentId,
  submissionId: 12,
  rootPublicCommentId: null,
  replyTargetPublicCommentId: null,
  version: 3,
  createdAt: "2026-08-23T12:00:00.000Z",
  edited: false,
  editedAt: null,
  tombstone: null,
  body: "Visible public Comment",
  author: {
    publicProfileId,
    displayName: "Ada",
    isCreator: false,
    isBanned: false,
  },
  mentions: [],
  replyCount: 0,
  voteCounts: { up: 1, down: 0 },
};

test("Comment account projection exposes only one fail-closed moderation Boolean", () => {
  const parsed = parseCommunityCommentAccountState({
    kind: "authenticated",
    canModerateComments: true,
    displayName: "Ada",
    publicProfileId,
    avatarUrl: null,
    unreadNotificationCount: 0,
    navigation: { kind: "authenticated", items: [], teamAccessUnavailable: false },
    roles: ["admin"],
    capabilities: ["community.comments.moderate"],
    discordUserId: "private",
    caseId: "private",
    moderationVersion: 99,
  });
  assert.deepEqual(parsed, {
    kind: "authenticated",
    canModerateComments: true,
    publicProfileId,
    displayName: "Ada",
  });
  assert.equal(parseCommunityCommentAccountState({
    kind: "authenticated",
    displayName: "Ada",
    publicProfileId,
  }).kind, "authenticated");
  assert.equal(parseCommunityCommentAccountState({
    kind: "authenticated",
    displayName: "Ada",
    publicProfileId,
  }).canModerateComments, false);
  assert.deepEqual(parseCommunityCommentAccountState({ kind: "anonymous" }), {
    kind: "anonymous",
  });
  assert.deepEqual(parseCommunityCommentAccountState(null), {
    kind: "dependency_unavailable",
  });
});

test("account route derives access from active Team navigation and fails closed", () => {
  assert.match(accountRoute, /item[.]id === "comment-moderation"/u);
  assert.match(accountRoute, /canModerateComments: false/gmu);
  assert.match(accountRoute, /TEAM_TOTP_REQUIRED/u);
  assert.match(accountRoute, /TEAM_SECURITY_CONTEXT_CHANGED/u);
  assert.match(accountRoute, /status === 403/u);
  assert.match(accountRoute, /status === 401 \|\| status === 503/u);
  assert.match(accountRoute, /Cache-Control": "no-store"/u);
  const commentAccountProjection = client.slice(
    client.indexOf("export function parseCommunityCommentAccountState"),
    client.indexOf("export async function fetchCommunityCommentAccount"),
  );
  assert.doesNotMatch(
    commentAccountProjection,
    /resolvedCapabilities|roles|capabilities|discordUserId|discord_user_id|caseId|reportId|moderationVersion/u,
  );
});

test("authorized inline access is capability-only, lazy, and retains Team-removed Restore", () => {
  assert.match(thread, /account[.]canModerateComments/u);
  assert.match(thread, /comment[.]tombstone !== "author_deleted"/u);
  assert.doesNotMatch(
    thread.slice(thread.indexOf("const canModerate"), thread.indexOf("const canVote")),
    /releaseState === "open"|comment[.]tombstone === null/u,
  );
  assert.match(menu, /aria-label="Team actions"/u);
  assert.match(menu, /<span aria-hidden="true">⋮<\/span>/u);
  assert.match(menu, />\s*Moderate Comment\s*<\/button>/u);
  assert.doesNotMatch(menu, /Issue Warning/u);
  assert.match(menu, /fetchCommunityCommentModerationTarget\(publicCommentId\)/u);
  assert.match(client, /moderation\?comment=\$\{encodeURIComponent\(publicCommentId\)\}/u);
  assert.match(moderationService, /requireDynamicTeamCapability\("community[.]comments[.]moderate"\)/u);
  assert.match(moderationRoute, /Cache-Control": "private, no-store"/u);
  assert.match(menu, /error[.]status === 401 \|\| error[.]status === 403/u);
  assert.doesNotMatch(menu, /error[.]status === 401 \|\| error[.]status === 403 \|\| error[.]status === 503/u);
  assert.match(menu, /Comment moderation is temporarily unavailable[.] Try again[.]/u);
});

test("lazy target load sends only the public Comment ID", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = null;
  let requestInit = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({
      outcome: "found",
      comment: publicComment,
      objectVersion: 3,
      moderationVersion: 0,
      removed: false,
      authorDeleted: false,
      submissionEligible: true,
      claimedForReview: false,
      reviewContext: {
        text: "Visible public Comment",
        textVersion: 2,
        lastModeration: null,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const target = await fetchCommunityCommentModerationTarget(publicCommentId);
    assert.equal(target.comment.publicCommentId, publicCommentId);
    assert.equal(target.reviewContext?.text, "Visible public Comment");
    assert.equal(target.reviewContext?.textVersion, 2);
    assert.equal(target.claimedForReview, false);
    assert.equal(requestUrl, `/api/admin/comments/moderation?comment=${publicCommentId}`);
    assert.deepEqual(requestInit, { cache: "no-store" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("protected review context is strict, bounded, and strips no hidden extras", () => {
  const context = parseCommunityCommentModerationReviewContext({
    text: "Stored Comment text",
    textVersion: 4,
    lastModeration: {
      action: "remove",
      reason: "Concrete internal reason",
      actorDisplayName: "Moderator",
      actorRole: "admin",
      createdAt: "2026-08-26T12:00:00.000Z",
      moderationVersion: 3,
    },
  });
  assert.equal(context?.text, "Stored Comment text");
  assert.equal(context?.lastModeration?.reason, "Concrete internal reason");
  assert.equal(parseCommunityCommentModerationReviewContext({
    ...context,
    actorDiscordUserId: "private",
  }), null);
  assert.equal(parseCommunityCommentModerationReviewContext({
    text: "Stored Comment text",
    textVersion: 4,
    lastModeration: {
      action: "remove",
      reason: "ok",
      actorDisplayName: "Moderator",
      actorRole: "admin",
      createdAt: "2026-08-26T12:00:00.000Z",
      moderationVersion: 3,
    },
  }), null);
});

test("protected database read models expose stored text and latest reason only after exact Team checks", () => {
  assert.match(reviewMigration, /assert_community_comment_capabilities[\s\S]*community[.]comments[.]moderate/u);
  assert.match(reviewMigration, /assert_team_inbox_topic_access/u);
  assert.match(reviewMigration, /community_comment_text_versions text_version/u);
  assert.match(reviewMigration, /text_version[.]normalized_body/u);
  assert.match(reviewMigration, /'textVersion', comment_row[.]current_text_version/u);
  assert.match(reviewMigration, /'reason', event[.]internal_reason/u);
  assert.match(reviewMigration, /when comment_row[.]author_deleted_at is not null then null/u);
  assert.match(reviewMigration, /'reviewContext'/u);
  assert.doesNotMatch(reviewMigration, /'actorDiscordUserId'|'reporterDiscordUserId'|'rawSpam'/u);
  assert.match(reviewCorrection, /assert_team_inbox_topic_access/u);
  assert.match(reviewCorrection, /assert_community_comment_capabilities[\s\S]*community[.]comments[.]moderate/u);
  assert.match(reviewCorrection, /v_can_moderate := true/u);
  assert.match(reviewCorrection, /when insufficient_privilege[\s\S]*v_can_moderate := false/u);
  assert.match(reviewCorrection, /case when v_can_moderate[\s\S]*build_community_comment_moderation_review_context/u);
  assert.match(caseDetail, /parseCommunityCommentModerationReviewContext/u);
  assert.match(caseDetail, /showStoredText=\{reportComment[.]tombstone === "team_removed"\}/u);
});

test("claimed Comment Reports expose only a neutral hold and block direct moderation atomically", async () => {
  assert.match(claimHoldMigration, /'claimedForReview', public[.]is_community_comment_claimed_for_review/u);
  assert.match(claimHoldMigration, /inbox_case[.]status = 'in_progress'/u);
  assert.match(claimHoldMigration, /report_case[.]status = 'open'/u);
  assert.match(claimHoldMigration, /'community-comment-moderation:' \|\| p_public_comment_id::text/u);
  assert.match(claimHoldMigration, /p_action = 'claim'[\s\S]*'community-comment-moderation:' \|\| v_public_comment_id::text/u);
  assert.match(claimHoldMigration, /jsonb_build_object\('outcome', 'claimed_for_review'\)/u);
  assert.match(menu, /Already being reviewed/u);
  assert.match(menu, /claimed Team Inbox case/u);
  assert.doesNotMatch(claimHoldMigration, /'claimant|'assigneeDiscord|'caseId'/u);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    outcome: "claimed_for_review",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      sendCommunityCommentModeration({
        publicCommentId,
        action: "remove",
        expectedObjectVersion: 3,
        expectedModerationVersion: 0,
        reason: "Required reason",
        requestId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18425",
      }),
      (error) => error instanceof CommunityCommentClientError &&
        error.status === 409 && error.code === "COMMENT_MODERATION_CLAIMED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Remove and Restore send the exact standalone payload and fresh request data", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const input = bodies.at(-1);
    return new Response(JSON.stringify({
      outcome: input.action === "remove" ? "removed" : "restored",
      publicCommentId,
      objectVersion: input.expectedObjectVersion + 1,
      moderationVersion: input.expectedModerationVersion + 1,
      comment: {
        ...publicComment,
        version: input.expectedObjectVersion + 1,
        tombstone: input.action === "remove" ? "team_removed" : null,
        body: input.action === "remove" ? null : publicComment.body,
        voteCounts: input.action === "remove" ? null : publicComment.voteCounts,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    for (const [index, action] of ["remove", "restore"].entries()) {
      await sendCommunityCommentModeration({
        publicCommentId,
        action,
        expectedObjectVersion: 3 + index,
        expectedModerationVersion: index,
        reason: `${action} reason`,
        requestId: `018f0ed0-5c89-4c0f-9c38-8cebd4e1842${5 + index}`,
      });
    }
    for (const body of bodies) {
      assert.deepEqual(Object.keys(body).sort(), [
        "action",
        "expectedModerationVersion",
        "expectedObjectVersion",
        "publicCommentId",
        "reason",
        "requestId",
      ]);
      assert.equal(body.publicCommentId, publicCommentId);
      assert.doesNotMatch(JSON.stringify(body), /case|topic|report|spam|source/iu);
    }
    assert.notEqual(bodies[0].requestId, bodies[1].requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale and unavailable moderation results never become successful receipts", async () => {
  const originalFetch = globalThis.fetch;
  for (const [outcome, status, code] of [
    ["stale", 409, "COMMENT_MODERATION_STALE"],
    ["unavailable", 409, "COMMENT_MODERATION_UNAVAILABLE"],
    ["claimed_for_review", 409, "COMMENT_MODERATION_CLAIMED"],
    ["comment_unavailable", 404, "COMMENT_MODERATION_UNAVAILABLE"],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ outcome }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      sendCommunityCommentModeration({
        publicCommentId,
        action: "remove",
        expectedObjectVersion: 3,
        expectedModerationVersion: 0,
        reason: "Required reason",
        requestId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18425",
      }),
      (error) => error instanceof CommunityCommentClientError &&
        error.status === status && error.code === code,
    );
  }
  globalThis.fetch = originalFetch;
});

test("successful moderation reloads the canonical public projection accessibly", () => {
  const mutationIndex = menu.indexOf("sendCommunityCommentModeration({");
  const publicReloadIndex = menu.indexOf("fetchCommunityCommentsBatch([publicCommentId])");
  const projectionIndex = menu.indexOf("onProjection(projection)");
  assert.ok(mutationIndex >= 0 && publicReloadIndex > mutationIndex && projectionIndex > publicReloadIndex);
  assert.match(menu, /role="alertdialog"/u);
  assert.match(menu, /confirmRef[.]current[?][.]focus\(\)/u);
  assert.match(menu, /document[.]addEventListener\("pointerdown"/u);
  assert.match(menu, /document[.]addEventListener\("keydown"/u);
  assert.match(menu, /event[.]key === "Escape"/u);
  assert.match(menu, /aria-label="Close Team actions"/u);
  assert.match(menu, /requestAnimationFrame\(\(\) => triggerRef[.]current[?][.]focus\(\)\)/u);
  assert.match(menu, /Internal reason \(required\)/u);
  assert.match(menu, /reason[.]trim\(\)[.]length < 3/u);
  assert.match(menu, /role=\{status[.]includes/u);
  assert.match(thread, /branchOpen: updated[.]tombstone === null/u);
  assert.match(thread, /rootVersion: updated[.]version/u);
});
