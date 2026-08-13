import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  data: null,
  error: null,
  health: null,
  healthReads: 0,
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "discord_member_state");
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: state.data, error: state.error });
          },
        };
      },
    },
  },
});

mock.module(
  new URL("../../lib/discord/readDiscordSyncHealth.ts", import.meta.url),
  {
    namedExports: {
      async readDiscordSyncHealth() {
        state.healthReads += 1;
        return state.health;
      },
    },
  }
);

const { getDiscordMembershipEligibility } = await import(
  "../../lib/eligibility/discordMembership.ts"
);

const timestampAgo = (ageMs) =>
  new Date(Date.now() - ageMs).toISOString();

function healthySync(overrides = {}) {
  return {
    last_heartbeat_at: timestampAgo(60 * 1000),
    last_full_reconciliation_succeeded_at: timestampAgo(2 * 60 * 1000),
    last_failure_at: null,
    ...overrides,
  };
}

function memberRow(overrides = {}) {
  return {
    discord_ban_active: false,
    discord_joined_at: timestampAgo(24 * 60 * 60 * 1000),
    discord_membership_observed_at: timestampAgo(89 * 60 * 1000),
    is_in_discord: true,
    ...overrides,
  };
}

test.beforeEach(() => {
  state.data = memberRow();
  state.error = null;
  state.health = healthySync();
  state.healthReads = 0;
});

test("a positive 89-minute observation is allowed regardless of sync health", async () => {
  for (const syncHealth of ["healthy", "degraded", "offline"]) {
    const result = await getDiscordMembershipEligibility("member-1");

    assert.equal(result.isEligible, true, syncHealth);
    assert.equal(result.membershipKnown, true, syncHealth);
    assert.equal(result.reason, null, syncHealth);
  }
});

test("a positive observation older than 90 minutes is pending regardless of sync health", async () => {
  state.data = memberRow({
    discord_membership_observed_at: timestampAgo(90 * 60 * 1000 + 1000),
  });

  for (const syncHealth of ["healthy", "degraded", "offline"]) {
    const result = await getDiscordMembershipEligibility("member-1");

    assert.equal(result.isEligible, false, syncHealth);
    assert.equal(result.membershipKnown, false, syncHealth);
    assert.equal(result.reason, "membership_pending", syncHealth);
  }
});

test("a fresh positive observation retains the ten-minute join cooldown", async () => {
  state.data = memberRow({
    discord_membership_observed_at: timestampAgo(60 * 1000),
    discord_joined_at: timestampAgo(9 * 60 * 1000),
  });

  const result = await getDiscordMembershipEligibility("member-1");

  assert.equal(result.isEligible, false);
  assert.equal(result.joinedTooRecently, true);
  assert.equal(result.reason, "joined_too_recently");
});

test("a fresh authenticated outsider missing from a healthy complete snapshot is not_in_discord", async () => {
  state.data = null;

  const result = await getDiscordMembershipEligibility("fresh-outsider");

  assert.equal(result.isEligible, false);
  assert.equal(result.isInDiscord, false);
  assert.equal(result.membershipKnown, true);
  assert.equal(result.reason, "not_in_discord");
  assert.equal(result.membershipObservedAt, null);
  assert.equal(result.joinedAt, null);
  assert.equal(state.healthReads, 1);
});

test("missing users remain pending for stale, degraded, offline, incomplete, failed, or unavailable sync evidence", async () => {
  state.data = null;
  const unsafeHealthStates = [
    healthySync({
      last_full_reconciliation_succeeded_at: timestampAgo(
        75 * 60 * 1000 + 1000
      ),
    }),
    healthySync({
      last_heartbeat_at: timestampAgo(12 * 60 * 1000 + 1000),
    }),
    healthySync({
      last_heartbeat_at: timestampAgo(30 * 60 * 1000 + 1000),
    }),
    healthySync({ last_full_reconciliation_succeeded_at: null }),
    healthySync({ last_failure_at: timestampAgo(30 * 1000) }),
    null,
  ];

  for (const health of unsafeHealthStates) {
    state.health = health;
    const result = await getDiscordMembershipEligibility("fresh-outsider");

    assert.equal(result.isEligible, false);
    assert.equal(result.isInDiscord, false);
    assert.equal(result.membershipKnown, false);
    assert.equal(result.reason, "membership_pending");
  }
});

test("a later observed join moves from invite state through the ten-minute cooldown to eligible", async () => {
  state.data = null;
  const outsider = await getDiscordMembershipEligibility("joining-user");
  assert.equal(outsider.reason, "not_in_discord");

  state.data = memberRow({
    discord_membership_observed_at: timestampAgo(30 * 1000),
    discord_joined_at: timestampAgo(60 * 1000),
  });
  const cooldown = await getDiscordMembershipEligibility("joining-user");
  assert.equal(cooldown.reason, "joined_too_recently");
  assert.equal(cooldown.joinedTooRecently, true);
  assert.ok(cooldown.retryAfterMs > 8 * 60 * 1000);
  assert.ok(cooldown.retryAfterMs <= 9 * 60 * 1000);

  state.data = memberRow({
    discord_membership_observed_at: timestampAgo(30 * 1000),
    discord_joined_at: timestampAgo(10 * 60 * 1000 + 1000),
  });
  const eligible = await getDiscordMembershipEligibility("joining-user");
  assert.equal(eligible.reason, null);
  assert.equal(eligible.isEligible, true);
  assert.equal(eligible.retryAfterMs, 0);
});

test("a fresh last-known non-member remains not_in_discord", async () => {
  state.data = memberRow({
    discord_membership_observed_at: timestampAgo(60 * 1000),
    is_in_discord: false,
  });

  const result = await getDiscordMembershipEligibility("non-member");

  assert.equal(result.isEligible, false);
  assert.equal(result.membershipKnown, true);
  assert.equal(result.reason, "not_in_discord");
  assert.equal(state.healthReads, 0);
});

test("Discord bans and dependency failures remain fail-closed", async () => {
  state.data = memberRow({ discord_ban_active: true });
  const banned = await getDiscordMembershipEligibility("banned-member");

  assert.equal(banned.isEligible, false);
  assert.equal(banned.isDiscordBanned, true);
  assert.equal(banned.reason, "discord_banned");

  state.error = { code: "DB_UNAVAILABLE" };
  await assert.rejects(
    getDiscordMembershipEligibility("member-1"),
    { code: "MEMBERSHIP_UNAVAILABLE", status: 503 }
  );
});
