import assert from "node:assert/strict";
import { mock, test } from "node:test";

const healthState = {
  row: null,
  error: null,
  calls: 0,
};

mock.module(
  new URL("../../lib/discord/readDiscordSyncHealth.ts", import.meta.url),
  {
    namedExports: {
      async readDiscordSyncHealth() {
        healthState.calls += 1;
        if (healthState.error) throw healthState.error;
        return healthState.row;
      },
    },
  }
);

const {
  DISCORD_SYNC_DELAY_NOTICE_BODY,
  DISCORD_SYNC_DELAY_NOTICE_GUIDANCE,
  DISCORD_SYNC_DELAY_NOTICE_TITLE,
  decideDiscordSyncDelayNotice,
} = await import("../../lib/eligibility/discordSyncDelayNotice.ts");
const { getDiscordSyncDelayNotice } = await import(
  "../../lib/auth/discordSyncDelayNotice.ts"
);

const timestampAgo = (ageMs) =>
  new Date(Date.now() - ageMs).toISOString();

const baseContext = (overrides = {}) => ({
  authenticated: true,
  participationEligible: false,
  membershipReason: "not_in_discord",
  websiteBanned: false,
  discordBanned: false,
  sessionValid: true,
  dependencyUnavailable: false,
  ...overrides,
});

const decide = (overrides = {}) =>
  decideDiscordSyncDelayNotice({
    ...baseContext(),
    syncHealthStatus: "degraded",
    ...overrides,
  });

function rowFor(status) {
  const base = {
    last_heartbeat_at: timestampAgo(60 * 1000),
    last_full_reconciliation_succeeded_at:
      timestampAgo(2 * 60 * 1000),
    last_failure_at: null,
  };

  if (status === "degraded") {
    return {
      ...base,
      last_heartbeat_at: timestampAgo(13 * 60 * 1000),
    };
  }

  if (status === "offline") {
    return { ...base, last_heartbeat_at: null };
  }

  return base;
}

test.beforeEach(() => {
  healthState.row = rowFor("degraded");
  healthState.error = null;
  healthState.calls = 0;
});

test("the exact required English notice text is preserved", () => {
  assert.equal(
    DISCORD_SYNC_DELAY_NOTICE_TITLE,
    "Discord verification is currently delayed."
  );
  assert.equal(
    DISCORD_SYNC_DELAY_NOTICE_BODY,
    "New and returning members may take longer than usual to be verified. The team has already been notified and is working to restore synchronization."
  );
  assert.equal(
    DISCORD_SYNC_DELAY_NOTICE_GUIDANCE,
    "Please remain on the Discord server. Leaving and rejoining will not speed up verification. Your status will update automatically once synchronization is restored."
  );
});

test("anonymous users never receive the notice", () => {
  assert.equal(decide({ authenticated: false }).showDiscordSyncDelayNotice, false);
});

test("normally eligible users never receive the notice", () => {
  assert.equal(
    decide({ participationEligible: true }).showDiscordSyncDelayNotice,
    false
  );
});

test("healthy not_in_discord keeps the normal display", () => {
  assert.equal(
    decide({ syncHealthStatus: "healthy" }).showDiscordSyncDelayNotice,
    false
  );
});

test("degraded and offline not_in_discord show the notice", () => {
  assert.equal(decide().showDiscordSyncDelayNotice, true);
  assert.equal(
    decide({ syncHealthStatus: "offline" }).showDiscordSyncDelayNotice,
    true
  );
});

test("healthy membership_pending keeps the normal pending display", () => {
  assert.equal(
    decide({
      membershipReason: "membership_pending",
      syncHealthStatus: "healthy",
    }).showDiscordSyncDelayNotice,
    false
  );
});

test("degraded and offline membership_pending show the notice", () => {
  assert.equal(
    decide({ membershipReason: "membership_pending" })
      .showDiscordSyncDelayNotice,
    true
  );
  assert.equal(
    decide({
      membershipReason: "membership_pending",
      syncHealthStatus: "offline",
    }).showDiscordSyncDelayNotice,
    true
  );
});

test("join wait and unrelated membership reasons never show the notice", () => {
  for (const membershipReason of [
    "joined_too_recently",
    "membership_unavailable",
    "discord_banned",
    null,
  ]) {
    assert.equal(
      decide({ membershipReason }).showDiscordSyncDelayNotice,
      false
    );
  }
});

test("Website ban, Discord ban, and invalid session suppress the notice", () => {
  assert.equal(decide({ websiteBanned: true }).showDiscordSyncDelayNotice, false);
  assert.equal(decide({ discordBanned: true }).showDiscordSyncDelayNotice, false);
  assert.equal(decide({ sessionValid: false }).showDiscordSyncDelayNotice, false);
});

test("technical dependency failures suppress the notice", () => {
  assert.equal(
    decide({ dependencyUnavailable: true }).showDiscordSyncDelayNotice,
    false
  );
});

test("the server helper reads Health only for display candidates", async () => {
  const nonCandidates = [
    baseContext({ authenticated: false }),
    baseContext({ participationEligible: true }),
    baseContext({ membershipReason: "joined_too_recently" }),
    baseContext({ websiteBanned: true }),
    baseContext({ discordBanned: true }),
    baseContext({ sessionValid: false }),
    baseContext({ dependencyUnavailable: true }),
  ];

  for (const context of nonCandidates) {
    assert.equal(await getDiscordSyncDelayNotice(context), false);
  }
  assert.equal(healthState.calls, 0);

  assert.equal(await getDiscordSyncDelayNotice(baseContext()), true);
  assert.equal(healthState.calls, 1);
});

test("the server helper applies healthy, degraded, and offline centrally", async () => {
  for (const [status, expected] of [
    ["healthy", false],
    ["degraded", true],
    ["offline", true],
  ]) {
    healthState.row = rowFor(status);
    assert.equal(await getDiscordSyncDelayNotice(baseContext()), expected);
  }
});

test("missing singleton and Health read errors preserve the normal display", async () => {
  healthState.row = null;
  assert.equal(await getDiscordSyncDelayNotice(baseContext()), false);

  healthState.error = new Error("private database details");
  assert.equal(await getDiscordSyncDelayNotice(baseContext()), false);
});

test("invalid Health timestamps fail closed", async () => {
  healthState.row = {
    ...rowFor("offline"),
    last_heartbeat_at: "not-a-date",
  };

  assert.equal(await getDiscordSyncDelayNotice(baseContext()), false);
});

test("display inputs are not mutated and decisions are deterministic", () => {
  const input = {
    ...baseContext({ membershipReason: "membership_pending" }),
    syncHealthStatus: "offline",
  };
  const before = structuredClone(input);

  const first = decideDiscordSyncDelayNotice(input);
  const second = decideDiscordSyncDelayNotice(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});
