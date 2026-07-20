import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  session: {
    discord_user_id: "discord-user-1",
    session_id: "session-1",
  },
  sessionError: null,
  membership: null,
  membershipError: null,
  healthRow: null,
  healthError: null,
  sessionCalls: 0,
  membershipCalls: 0,
  healthCalls: 0,
};

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    async requireSession() {
      state.sessionCalls += 1;
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
        state.membershipCalls += 1;
        if (state.membershipError) throw state.membershipError;
        return state.membership;
      },
    },
  }
);

mock.module(
  new URL("../../lib/discord/readDiscordSyncHealth.ts", import.meta.url),
  {
    namedExports: {
      async readDiscordSyncHealth() {
        state.healthCalls += 1;
        if (state.healthError) throw state.healthError;
        return state.healthRow;
      },
    },
  }
);

const { getParticipationAccess, requireParticipation } = await import(
  "../../lib/auth/participationGuard.ts"
);

const timestampAgo = (ageMs) =>
  new Date(Date.now() - ageMs).toISOString();

function eligibleMembership(overrides = {}) {
  return {
    isInDiscord: true,
    isEligible: true,
    isDiscordBanned: false,
    membershipKnown: true,
    dependencyUnavailable: false,
    membershipObservedAt: timestampAgo(5 * 60 * 1000),
    joinedAt: timestampAgo(24 * 60 * 60 * 1000),
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
    membershipObservedAt: timestampAgo(91 * 60 * 1000),
    reason: "membership_pending",
    ...overrides,
  });
}

function healthRow(status) {
  if (status === "healthy") {
    return {
      last_heartbeat_at: timestampAgo(60 * 1000),
      last_full_reconciliation_succeeded_at:
        timestampAgo(2 * 60 * 1000),
      last_failure_at: timestampAgo(3 * 60 * 1000),
    };
  }

  if (status === "degraded") {
    return {
      last_heartbeat_at: timestampAgo(13 * 60 * 1000),
      last_full_reconciliation_succeeded_at:
        timestampAgo(2 * 60 * 1000),
      last_failure_at: null,
    };
  }

  return {
    last_heartbeat_at: null,
    last_full_reconciliation_succeeded_at:
      timestampAgo(2 * 60 * 1000),
    last_failure_at: null,
  };
}

function resetState() {
  state.session = {
    discord_user_id: "discord-user-1",
    session_id: "session-1",
  };
  state.sessionError = null;
  state.membership = eligibleMembership();
  state.membershipError = null;
  state.healthRow = healthRow("degraded");
  state.healthError = null;
  state.sessionCalls = 0;
  state.membershipCalls = 0;
  state.healthCalls = 0;
}

async function assertParticipationCode(code) {
  await assert.rejects(requireParticipation(), (error) => {
    assert.equal(error.code.split(":")[0], code);
    return true;
  });
}

test.beforeEach(resetState);

test("a fresh confirmed member remains allowed without a health read", async () => {
  const result = await requireParticipation();

  assert.equal(result.access.participationEligible, true);
  assert.equal(result.membership.isEligible, true);
  assert.equal(result.discordSyncParticipationGrace, null);
  assert.equal(state.healthCalls, 0);
});

test("healthy sync preserves stale membership_pending", async () => {
  state.membership = pendingMembership();
  state.healthRow = healthRow("healthy");

  await assertParticipationCode("MEMBERSHIP_PENDING");
  assert.equal(state.healthCalls, 1);
});

test("degraded sync allows stale positive established membership", async () => {
  state.membership = pendingMembership();
  state.healthRow = healthRow("degraded");

  const result = await requireParticipation();

  assert.equal(result.access.participationEligible, true);
  assert.equal(result.membership.isEligible, true);
  assert.equal(result.membership.membershipKnown, true);
  assert.deepEqual(result.discordSyncParticipationGrace, {
    allowed: true,
    mode: "degraded_grace",
    reason: "confirmed_member_sync_stale",
    usedDegradedGrace: true,
  });
});

test("offline sync grants the same request-local grace", async () => {
  state.membership = pendingMembership();
  state.healthRow = healthRow("offline");

  const result = await requireParticipation();

  assert.equal(result.access.status, "eligible");
  assert.equal(result.discordSyncParticipationGrace?.usedDegradedGrace, true);
});

test("a known non-member remains blocked without a health read", async () => {
  state.membership = eligibleMembership({
    isInDiscord: false,
    isEligible: false,
    reason: "not_in_discord",
  });

  await assertParticipationCode("NOT_IN_DISCORD");
  assert.equal(state.healthCalls, 0);
});

test("an unconfirmed new member remains pending without a health read", async () => {
  state.membership = pendingMembership({
    isInDiscord: false,
    membershipObservedAt: null,
    joinedAt: null,
  });

  await assertParticipationCode("MEMBERSHIP_PENDING");
  assert.equal(state.healthCalls, 0);
});

test("an unconfirmed rejoin remains pending without a health read", async () => {
  state.membership = pendingMembership({
    isInDiscord: false,
    membershipObservedAt: timestampAgo(7 * 24 * 60 * 60 * 1000),
    joinedAt: timestampAgo(7 * 24 * 60 * 60 * 1000),
  });

  await assertParticipationCode("MEMBERSHIP_PENDING");
  assert.equal(state.healthCalls, 0);
});

test("missing, invalid, and future membership observations never receive grace", async () => {
  const observations = [
    null,
    "not-a-date",
    new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  ];

  for (const membershipObservedAt of observations) {
    resetState();
    state.membership = pendingMembership({ membershipObservedAt });
    await assertParticipationCode("MEMBERSHIP_PENDING");
    assert.equal(state.healthCalls, 1);
  }
});

test("a missing or invalid join timestamp never receives grace", async () => {
  for (const joinedAt of [null, "not-a-date"]) {
    resetState();
    state.membership = pendingMembership({ joinedAt });
    await assertParticipationCode("MEMBERSHIP_PENDING");
  }
});

test("a stale pending membership below the ten-minute join wait remains blocked", async () => {
  state.membership = pendingMembership({
    joinedAt: timestampAgo(9 * 60 * 1000),
  });

  await assertParticipationCode("MEMBERSHIP_PENDING");
});

test("an existing joined_too_recently decision skips the health read", async () => {
  state.membership = eligibleMembership({
    isEligible: false,
    joinedTooRecently: true,
    retryAfterMs: 60 * 1000,
    reason: "joined_too_recently",
  });

  await assertParticipationCode("JOINED_TOO_RECENTLY");
  assert.equal(state.healthCalls, 0);
});

test("an exactly completed ten-minute wait can receive grace", async () => {
  state.membership = pendingMembership({
    joinedAt: timestampAgo(10 * 60 * 1000),
  });

  const result = await requireParticipation();

  assert.equal(result.access.participationEligible, true);
  assert.equal(result.discordSyncParticipationGrace?.mode, "degraded_grace");
});

test("Discord bans remain hard blocks without a health read", async () => {
  state.membership = eligibleMembership({
    isInDiscord: false,
    isEligible: false,
    isDiscordBanned: true,
    reason: "discord_banned",
  });

  await assertParticipationCode("DISCORD_BANNED");
  assert.equal(state.healthCalls, 0);
});

test("website bans and revoked sessions stop before membership and health", async () => {
  for (const code of ["WEBSITE_BANNED", "NOT_AUTHENTICATED"]) {
    resetState();
    const error = Object.assign(new Error(code), { code });
    state.sessionError = error;

    await assert.rejects(requireParticipation(), (caught) => caught === error);
    assert.equal(state.membershipCalls, 0);
    assert.equal(state.healthCalls, 0);
  }
});

test("membership dependency errors remain hard failures without a health read", async () => {
  const dependencyError = new Error("membership dependency unavailable");
  state.membershipError = dependencyError;

  await assert.rejects(
    requireParticipation(),
    (caught) => caught === dependencyError
  );
  assert.equal(state.healthCalls, 0);
});

test("membership_unavailable remains blocked without a health read", async () => {
  state.membership = eligibleMembership({
    isEligible: false,
    dependencyUnavailable: true,
    reason: "membership_unavailable",
  });

  await assertParticipationCode("MEMBERSHIP_UNAVAILABLE");
  assert.equal(state.healthCalls, 0);
});

test("a missing health singleton preserves membership_pending", async () => {
  state.membership = pendingMembership();
  state.healthRow = null;

  await assertParticipationCode("MEMBERSHIP_PENDING");
  assert.equal(state.healthCalls, 1);
});

test("a health read error preserves membership_pending", async () => {
  state.membership = pendingMembership();
  state.healthError = new Error("private database details");

  await assertParticipationCode("MEMBERSHIP_PENDING");
  assert.equal(state.healthCalls, 1);
});

test("a health read failure cannot block a normally allowed member", async () => {
  state.healthError = new Error("private database details");

  const result = await requireParticipation();

  assert.equal(result.access.participationEligible, true);
  assert.equal(state.healthCalls, 0);
});

test("invalid stored health timestamps fail closed", async () => {
  state.membership = pendingMembership();
  state.healthRow = {
    ...healthRow("offline"),
    last_heartbeat_at: "not-a-date",
  };

  await assertParticipationCode("MEMBERSHIP_PENDING");
});

test("there is no automatic maximum age for confirmed membership", async () => {
  state.membership = pendingMembership({
    membershipObservedAt: timestampAgo(365 * 24 * 60 * 60 * 1000),
  });

  const result = await requireParticipation();

  assert.equal(result.access.participationEligible, true);
  assert.equal(result.discordSyncParticipationGrace?.usedDegradedGrace, true);
});

test("membership and health inputs are not mutated", async () => {
  state.membership = pendingMembership();
  state.healthRow = healthRow("degraded");
  const membershipBefore = structuredClone(state.membership);
  const healthBefore = structuredClone(state.healthRow);

  const result = await getParticipationAccess();

  assert.deepEqual(state.membership, membershipBefore);
  assert.deepEqual(state.healthRow, healthBefore);
  assert.notEqual(result.membership, state.membership);
});
