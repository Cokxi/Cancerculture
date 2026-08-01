import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const state = {
  session: {
    discord_user_id: "discord-user-1",
    session_id: "session-1",
  },
  sessionError: null,
  membership: null,
  membershipError: null,
  participationHeld: false,
};

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    async requireSession() {
      if (state.sessionError) throw state.sessionError;
      return state.session;
    },
  },
});

mock.module(
  new URL("../../lib/eligibility/discordMembership.ts", import.meta.url),
  {
    namedExports: {
      async getDiscordMembershipEligibility() {
        if (state.membershipError) throw state.membershipError;
        return state.membership;
      },
    },
  }
);

mock.module(
  new URL("../../lib/eligibility/participationHold.ts", import.meta.url),
  {
    namedExports: {
      async getParticipationHold() {
        return state.participationHeld;
      },
    },
  }
);

const { getParticipationAccess, requireParticipation } = await import(
  "../../lib/auth/participationGuard.ts"
);

function eligibleMembership(overrides = {}) {
  return {
    isInDiscord: true,
    isEligible: true,
    isDiscordBanned: false,
    membershipKnown: true,
    dependencyUnavailable: false,
    membershipObservedAt: new Date(
      Date.now() - 89 * 60 * 1000
    ).toISOString(),
    joinedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    joinedTooRecently: false,
    retryAfterMs: 0,
    reason: null,
    ...overrides,
  };
}

function pendingMembership(overrides = {}) {
  return eligibleMembership({
    isEligible: false,
    membershipKnown: false,
    membershipObservedAt: new Date(
      Date.now() - 91 * 60 * 1000
    ).toISOString(),
    reason: "membership_pending",
    ...overrides,
  });
}

async function assertParticipationCode(code) {
  await assert.rejects(requireParticipation(), (error) => {
    assert.equal(error.code.split(":")[0], code);
    return true;
  });
}

test.beforeEach(() => {
  state.sessionError = null;
  state.membership = eligibleMembership();
  state.membershipError = null;
  state.participationHeld = false;
});

test("an escalated case blocks participation with a neutral result", async () => {
  state.participationHeld = true;
  const result = await getParticipationAccess();
  assert.equal(result.access.status, "temporarily_unavailable");
  await assertParticipationCode("PARTICIPATION_UNAVAILABLE");
});

test("the central guard allows fresh membership with only the canonical result", async () => {
  const result = await requireParticipation();

  assert.equal(result.access.status, "eligible");
  assert.equal(result.membership, state.membership);
  assert.deepEqual(Object.keys(result).sort(), ["access", "membership", "session"]);
});

test("stale positive membership remains membership_pending", async () => {
  state.membership = pendingMembership();

  const result = await getParticipationAccess();
  assert.equal(result.access.status, "membership_pending");
  assert.equal(result.access.participationEligible, false);
  await assertParticipationCode("MEMBERSHIP_PENDING");
});

test("join cooldown, unknown users, and known non-members retain their blocks", async () => {
  state.membership = eligibleMembership({
    isEligible: false,
    joinedTooRecently: true,
    retryAfterMs: 60 * 1000,
    reason: "joined_too_recently",
  });
  await assertParticipationCode("JOINED_TOO_RECENTLY");

  state.membership = pendingMembership({
    isInDiscord: false,
    membershipObservedAt: null,
    joinedAt: null,
  });
  await assertParticipationCode("MEMBERSHIP_PENDING");

  state.membership = eligibleMembership({
    isInDiscord: false,
    isEligible: false,
    reason: "not_in_discord",
  });
  await assertParticipationCode("NOT_IN_DISCORD");
});

test("Discord bans and dependency-unavailable membership fail closed", async () => {
  state.membership = eligibleMembership({
    isInDiscord: false,
    isEligible: false,
    isDiscordBanned: true,
    reason: "discord_banned",
  });
  await assertParticipationCode("DISCORD_BANNED");

  state.membership = eligibleMembership({
    isEligible: false,
    dependencyUnavailable: true,
    reason: "membership_unavailable",
  });
  await assertParticipationCode("MEMBERSHIP_UNAVAILABLE");
});

test("website bans, revoked sessions, and membership read errors remain fail-closed", async () => {
  for (const code of ["WEBSITE_BANNED", "NOT_AUTHENTICATED"]) {
    const sessionError = Object.assign(new Error(code), { code });
    state.sessionError = sessionError;
    await assert.rejects(requireParticipation(), (error) => error === sessionError);
    state.sessionError = null;
  }

  const membershipError = new Error("membership dependency unavailable");
  state.membershipError = membershipError;
  await assert.rejects(
    requireParticipation(),
    (error) => error === membershipError
  );
});

test("Upload and Vote use the same guard before all commit work", async () => {
  const [guard, uploadRoute, voteRoute] = await Promise.all([
    readFile(
      new URL("../../lib/auth/participationGuard.ts", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../../app/api/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/vote/route.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(
    guard,
    /readDiscordSyncHealth|evaluateDiscordSyncHealth/
  );
  assert.match(uploadRoute, /const \{ session \} = await requireParticipation\(\)/);
  assert.match(
    voteRoute,
    /const \{ membership, session \} = await requireParticipation\(\)/
  );
  assert.ok(uploadRoute.indexOf("requireParticipation()") < uploadRoute.indexOf("req.formData()"));
  assert.ok(voteRoute.indexOf("requireParticipation()") < voteRoute.indexOf("req.formData()"));
});
