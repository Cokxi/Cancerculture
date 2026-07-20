import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const state = {
  participationResult: null,
  voteEligibility: null,
  notice: true,
  noticeContexts: [],
  membershipOverrides: [],
};

mock.module(
  new URL("../../lib/auth/participationGuard.ts", import.meta.url),
  {
    namedExports: {
      async getParticipationAccess() {
        return state.participationResult;
      },
    },
  }
);

mock.module(
  new URL("../../lib/auth/discordSyncDelayNotice.ts", import.meta.url),
  {
    namedExports: {
      async getDiscordSyncDelayNotice(context) {
        state.noticeContexts.push(context);
        return state.notice;
      },
    },
  }
);

mock.module(
  new URL("../../lib/vote/getVoteEligibility.ts", import.meta.url),
  {
    namedExports: {
      async getVoteEligibility(_discordUserId, membershipOverride) {
        state.membershipOverrides.push(membershipOverride);
        return state.voteEligibility;
      },
    },
  }
);

const voteEligibilityRoute = await import(
  "../../app/api/vote/eligibility/route.ts"
);

function membership(overrides = {}) {
  return {
    isInDiscord: false,
    isEligible: false,
    isDiscordBanned: false,
    membershipKnown: true,
    dependencyUnavailable: false,
    membershipObservedAt: "2026-07-18T10:00:00.000Z",
    joinedAt: "2026-07-18T10:00:00.000Z",
    joinedTooRecently: false,
    retryAfterMs: 0,
    reason: "not_in_discord",
    ...overrides,
  };
}

function access(overrides = {}) {
  return {
    authenticated: true,
    membershipKnown: true,
    discordMember: false,
    participationEligible: false,
    discordBanned: false,
    websiteBanned: false,
    joinWaitActive: false,
    dependencyUnavailable: false,
    joinedAt: "2026-07-18T10:00:00.000Z",
    retryAfterMs: 0,
    status: "not_in_discord",
    ...overrides,
  };
}

test.beforeEach(() => {
  const currentMembership = membership();
  state.participationResult = {
    access: access(),
    membership: currentMembership,
    session: {
      discord_user_id: "discord-user-1",
      session_id: "session-1",
    },
    discordSyncParticipationGrace: null,
  };
  state.voteEligibility = {
    isBanned: false,
    activeCycleId: 1,
    hasVoted: false,
    voteCount: 0,
    votesPerUser: 2,
    votedSubmissionIds: [],
    membership: currentMembership,
  };
  state.notice = true;
  state.noticeContexts = [];
  state.membershipOverrides = [];
});

test("Vote uses the central Participation result and display decision", async () => {
  const response = await voteEligibilityRoute.GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.showDiscordSyncDelayNotice, true);
  assert.equal(state.membershipOverrides.length, 1);
  assert.equal(
    state.membershipOverrides[0],
    state.participationResult.membership
  );
  assert.deepEqual(state.noticeContexts, [
    {
      authenticated: true,
      participationEligible: false,
      membershipReason: "not_in_discord",
      websiteBanned: false,
      discordBanned: false,
      sessionValid: true,
      dependencyUnavailable: false,
      usedDegradedGrace: false,
    },
  ]);
});

test("the Vote response exposes only the display Boolean, not Health internals", async () => {
  const response = await voteEligibilityRoute.GET();
  const serialized = JSON.stringify(await response.json());

  assert.doesNotMatch(
    serialized,
    /last_heartbeat|reconciliation|last_failure|failure_code|secret|reasons/i
  );
  assert.match(serialized, /"showDiscordSyncDelayNotice":true/);
});

test("granted Grace remains eligible and produces no notice", async () => {
  state.notice = false;
  state.participationResult = {
    ...state.participationResult,
    access: access({
      discordMember: true,
      participationEligible: true,
      status: "eligible",
    }),
    membership: membership({
      isInDiscord: true,
      isEligible: true,
      reason: null,
    }),
    discordSyncParticipationGrace: {
      allowed: true,
      mode: "degraded_grace",
      reason: "confirmed_member_sync_stale",
      usedDegradedGrace: true,
    },
  };
  state.voteEligibility = {
    ...state.voteEligibility,
    membership: state.participationResult.membership,
  };

  const response = await voteEligibilityRoute.GET();
  const body = await response.json();

  assert.equal(body.participation.status, "eligible");
  assert.equal(body.showDiscordSyncDelayNotice, false);
  assert.equal(state.noticeContexts[0].usedDegradedGrace, true);
});

test("Upload and Vote wire the same central server and display helpers", async () => {
  const [uploadPage, uploadClient, voteRoute, voteClient] =
    await Promise.all([
      readFile(new URL("../../app/upload/page.tsx", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../app/components/upload/DesktopUpload.tsx",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../../app/api/vote/eligibility/route.ts",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../../app/submissions/SubmissionsClient.tsx",
          import.meta.url
        ),
        "utf8"
      ),
    ]);

  assert.match(uploadPage, /getDiscordSyncDelayNotice/);
  assert.match(voteRoute, /getDiscordSyncDelayNotice/);
  assert.match(uploadClient, /DiscordSyncDelayNotice/);
  assert.match(voteClient, /DiscordSyncDelayNotice/);

  for (const source of [uploadPage, uploadClient, voteRoute, voteClient]) {
    assert.doesNotMatch(
      source,
      /HEARTBEAT_DEGRADED|HEARTBEAT_OFFLINE|RECONCILIATION_STALE/
    );
    assert.doesNotMatch(
      source,
      /last_heartbeat_at|last_failure_at|DISCORD_SYNC_HEALTH_SECRET/
    );
  }
});

test("no global navigation or Homepage warning was added", async () => {
  const [homepage, layout, navigationFiles] = await Promise.all([
    readFile(new URL("../../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../app/layout.tsx", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../app/components/navigation/HomeMenu.tsx",
        import.meta.url
      ),
      "utf8"
    ),
  ]);

  for (const source of [homepage, layout, navigationFiles]) {
    assert.doesNotMatch(source, /DiscordSyncDelayNotice/);
    assert.doesNotMatch(source, /Discord verification is currently delayed/);
  }
});
