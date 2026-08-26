import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CommunityCommentClientError,
  fetchCommunityCommentAccount,
  fetchCommunityCommentModerationTarget,
  fetchCommunityCommentWarningTarget,
  parseCommunityCommentAccountState,
  parseCommunityCommentModerationReviewContext,
  sendCommunityCommentModeration,
  sendCommunityCommentWarning,
} from "../../lib/comments/commentClient.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [accountRoute, caseDetail, claimHoldMigration, client, menu, moderationService, moderationRoute, reviewCorrection, reviewMigration, thread, warningPanel, warningRoute, warningService, warningTargetMigration] =
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
    read("app/components/comments/CommunityCommentWarningPanel.tsx"),
    read("app/api/admin/comments/warnings/route.ts"),
    read("lib/comments/commentWarning.server.ts"),
    read("supabase/migrations/20260826000600_user_warning_issue_target.sql"),
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

test("Comment account projection keeps the global Account free of Warning capability policy", () => {
  const parsed = parseCommunityCommentAccountState({
    kind: "authenticated",
    canIssueCommentWarnings: false,
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
    canIssueCommentWarnings: false,
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
  }).canIssueCommentWarnings, false);
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

test("Comment-specific Warning access stays out of global Account policy and fails closed", () => {
  assert.match(accountRoute, /getResolvedTeamAreaNavigation\(\)/u);
  assert.doesNotMatch(accountRoute, /hasResolvedTeamCapability/u);
  assert.doesNotMatch(accountRoute, /users[.]warnings[.]issue/u);
  assert.match(accountRoute, /canModerateComments: false/gmu);
  assert.match(accountRoute, /TEAM_TOTP_REQUIRED/u);
  assert.match(accountRoute, /TEAM_SECURITY_CONTEXT_CHANGED/u);
  assert.match(accountRoute, /status === 403/u);
  assert.match(accountRoute, /status === 401 \|\| status === 503/u);
  assert.match(accountRoute, /Cache-Control": "no-store"/u);
  assert.match(warningRoute, /searchParams[.]get\("access"\) === "1"/u);
  assert.match(warningRoute, /loadCommunityCommentWarningAccess\(\)/u);
  assert.match(warningService, /getTeamAuthorizationContext\(\)/u);
  assert.match(warningService, /hasResolvedTeamCapability\(/u);
  const commentAccountProjection = client.slice(
    client.indexOf("export function parseCommunityCommentAccountState"),
    client.indexOf("export async function fetchCommunityCommentAccount"),
  );
  assert.doesNotMatch(
    commentAccountProjection,
    /resolvedCapabilities|roles|capabilities|discordUserId|discord_user_id|caseId|reportId|moderationVersion/u,
  );
});

test("Comment account lazily merges only the dedicated Warning-access Boolean", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === "/api/auth/account") {
      return new Response(JSON.stringify({
        kind: "authenticated",
        canModerateComments: true,
        displayName: "Ada",
        publicProfileId,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ canIssueWarning: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await fetchCommunityCommentAccount(), {
      kind: "authenticated",
      canIssueCommentWarnings: true,
      canModerateComments: true,
      publicProfileId,
      displayName: "Ada",
    });
    assert.deepEqual(calls, [
      { url: "/api/auth/account", init: { cache: "no-store" } },
      { url: "/api/admin/comments/warnings?access=1", init: { cache: "no-store" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorized inline access is capability-only, lazy, and exposes independent moderation and Warning actions", () => {
  assert.match(thread, /account[.]canModerateComments \|\| account[.]canIssueCommentWarnings/u);
  assert.match(thread, /comment[.]tombstone !== "author_deleted"/u);
  assert.doesNotMatch(
    thread.slice(thread.indexOf("const canUseTeamActions"), thread.indexOf("const canVote")),
    /releaseState === "open"|comment[.]tombstone === null/u,
  );
  assert.match(menu, /aria-label="Team actions"/u);
  assert.match(menu, /<span aria-hidden="true">⋮<\/span>/u);
  assert.match(menu, />\s*Moderate Comment\s*<\/button>/u);
  assert.match(menu, />\s*Issue Warning\s*<\/button>/u);
  assert.match(menu, /canModerate/u);
  assert.match(menu, /canIssueWarning/u);
  assert.match(menu, /fetchCommunityCommentModerationTarget\(publicCommentId\)/u);
  assert.match(warningPanel, /fetchCommunityCommentWarningTarget\(publicCommentId\)/u);
  assert.match(client, /moderation\?comment=\$\{encodeURIComponent\(publicCommentId\)\}/u);
  assert.match(client, /warnings\?comment=\$\{encodeURIComponent\(publicCommentId\)\}/u);
  assert.match(moderationService, /requireDynamicTeamCapability\("community[.]comments[.]moderate"\)/u);
  assert.equal(
    warningService.match(/requireDynamicTeamCapability\("users[.]warnings[.]issue"\)/gu)?.length,
    2,
  );
  assert.match(moderationRoute, /Cache-Control": "private, no-store"/u);
  assert.match(warningRoute, /Cache-Control": "private, no-store"/u);
  assert.match(menu, /error[.]status === 401 \|\| error[.]status === 403/u);
  assert.doesNotMatch(menu, /error[.]status === 401 \|\| error[.]status === 403 \|\| error[.]status === 503/u);
  assert.match(menu, /Comment moderation is temporarily unavailable[.] Try again[.]/u);
  assert.match(thread, /canIssueCommentWarnings: false/u);
  assert.match(thread, /canModerateComments: false/u);
});

test("lazy Warning target load sends only the public Comment ID and accepts only minimal evidence", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = null;
  let requestInit = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({
      outcome: "found",
      publicCommentId,
      objectVersion: 3,
      textVersion: 2,
      text: "Visible public Comment",
      available: true,
      alreadyWarned: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const target = await fetchCommunityCommentWarningTarget(publicCommentId);
    assert.deepEqual(target, {
      outcome: "found",
      publicCommentId,
      objectVersion: 3,
      textVersion: 2,
      text: "Visible public Comment",
      available: true,
      alreadyWarned: false,
    });
    assert.equal(requestUrl, `/api/admin/comments/warnings?comment=${publicCommentId}`);
    assert.deepEqual(requestInit, { cache: "no-store" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Warning mutation sends exact Comment-bound input and no duration or identity", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = null;
  let body = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      outcome: "issued",
      publicCommentId,
      tierDays: 1,
      issuedAt: "2026-08-26T15:00:00.000Z",
      expiresAt: "2026-08-27T15:00:00.000Z",
      replayed: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const receipt = await sendCommunityCommentWarning({
      publicCommentId,
      expectedObjectVersion: 3,
      expectedTextVersion: 2,
      category: "other",
      reason: "This Comment crosses the line.",
      requestId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18425",
    });
    assert.equal(receipt.tierDays, 1);
    assert.equal(requestUrl, "/api/admin/comments/warnings");
    assert.deepEqual(Object.keys(body).sort(), [
      "category",
      "expectedObjectVersion",
      "expectedTextVersion",
      "publicCommentId",
      "reason",
      "requestId",
    ]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /duration|tierDays|targetDiscord|actorDiscord|caseId|reportId/iu,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Warning UI explains permanent source uniqueness, automatic duration, and sanction-free behavior", () => {
  assert.match(warningPanel, /Exact Comment evidence/u);
  assert.match(warningPanel, /Category \(required\)/u);
  assert.match(warningPanel, /Warning message \(required\)/u);
  assert.match(warningPanel, /permanently bound to this exact Comment/u);
  assert.match(warningPanel, /assigns its duration automatically/u);
  assert.match(warningPanel, /does not remove the[\s\S]*automatic ban or participation hold/u);
  assert.match(warningPanel, /Warning already issued/u);
  assert.match(warningPanel, /crypto[.]randomUUID\(\)/u);
  assert.doesNotMatch(warningPanel, /Report ID|Comment ID|duration.*select/iu);
  assert.match(warningService, /exactKeys\(input/u);
  assert.match(warningService, /p_expected_comment_object_version/u);
  assert.match(warningService, /p_expected_comment_text_version/u);
  assert.doesNotMatch(warningService, /p_duration|p_target_discord_user_id/u);
  assert.match(warningTargetMigration, /get_user_warning_issue_target/u);
});

test("Warning target loading is stable across parent renders and cannot become a scroll anchor", () => {
  assert.match(warningPanel, /const accessUnavailableRef = useRef\(onAccessUnavailable\)/u);
  assert.match(warningPanel, /const busyChangeRef = useRef\(onBusyChange\)/u);
  assert.match(warningPanel, /accessUnavailableRef[.]current\(\)/u);
  assert.match(warningPanel, /busyChangeRef[.]current\(busy\)/u);
  const targetLoader = warningPanel.slice(
    warningPanel.indexOf("const loadTarget = useCallback"),
    warningPanel.indexOf("useEffect(() => {\n    void loadTarget();"),
  );
  assert.equal(targetLoader.includes("}, [publicCommentId]);"), true);
  assert.doesNotMatch(targetLoader, /\[onAccessUnavailable, publicCommentId\]/u);
  assert.match(menu, /style=\{\{ overflowAnchor: "none" \}\}/u);
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
