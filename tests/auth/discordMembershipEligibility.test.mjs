import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  data: null,
  error: null,
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

const { getDiscordMembershipEligibility } = await import(
  "../../lib/eligibility/discordMembership.ts"
);

const timestampAgo = (ageMs) =>
  new Date(Date.now() - ageMs).toISOString();

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

test("an unknown user is membership_pending", async () => {
  state.data = null;

  const result = await getDiscordMembershipEligibility("unknown-user");

  assert.equal(result.isEligible, false);
  assert.equal(result.membershipKnown, false);
  assert.equal(result.reason, "membership_pending");
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
