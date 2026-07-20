import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AuthError } from "../../lib/auth/AuthError.ts";
import { getTeamPageAccessRedirect } from "../../lib/auth/pageAccessDecision.ts";
import { createParticipationAccessState } from "../../lib/eligibility/participation.ts";

const state = {
  participationCalls: 0,
  participationError: null,
  queriedDiscordUserId: null,
  session: {
    discord_user_id: "team-user-1",
    session_id: "00000000-0000-4000-8000-000000000001",
  },
  sessionError: null,
  teamResult: {
    data: { discord_user_id: "team-user-1", role: "admin" },
    error: null,
  },
};

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    requireSession: async () => {
      if (state.sessionError) throw state.sessionError;
      return state.session;
    },
  },
});

mock.module(
  new URL("../../lib/auth/participationGuard.ts", import.meta.url),
  {
    namedExports: {
      requireParticipation: async () => {
        state.participationCalls += 1;
        if (state.participationError) throw state.participationError;
        return { session: state.session };
      },
    },
  }
);

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "team_members");
        return {
          select(columns) {
            assert.equal(columns, "discord_user_id, role");
            return this;
          },
          eq(column, value) {
            assert.equal(column, "discord_user_id");
            state.queriedDiscordUserId = value;
            return this;
          },
          maybeSingle() {
            return Promise.resolve(state.teamResult);
          },
        };
      },
    },
  },
});

const { requireAdmin, requireModOrAdmin } = await import(
  "../../lib/auth/guards.ts"
);

function resetState() {
  state.participationCalls = 0;
  state.participationError = null;
  state.queriedDiscordUserId = null;
  state.sessionError = null;
  state.teamResult = {
    data: { discord_user_id: "team-user-1", role: "admin" },
    error: null,
  };
}

test.beforeEach(resetState);

test("Admin with a valid session and fresh membership receives access", async () => {
  const member = await requireAdmin();

  assert.equal(member.role, "admin");
  assert.equal(state.queriedDiscordUserId, state.session.discord_user_id);
});

test("Admin with stale membership (membership_pending) receives access", async () => {
  state.participationError = new AuthError(
    403,
    "Discord membership verification pending",
    "MEMBERSHIP_PENDING"
  );

  assert.equal((await requireAdmin()).role, "admin");
  assert.equal(state.participationCalls, 0);
});

test("Admin remains authorized while membership sync is unavailable", async () => {
  state.participationError = new AuthError(
    503,
    "Membership verification temporarily unavailable",
    "MEMBERSHIP_UNAVAILABLE"
  );

  assert.equal((await requireAdmin()).role, "admin");
  assert.equal(state.participationCalls, 0);
});

test("Moderator with stale membership receives moderation access", async () => {
  state.teamResult = {
    data: { discord_user_id: "team-user-1", role: "mod" },
    error: null,
  };
  state.participationError = new AuthError(
    403,
    "Discord membership verification pending",
    "MEMBERSHIP_PENDING"
  );

  assert.equal((await requireModOrAdmin()).role, "mod");
  assert.equal(state.participationCalls, 0);
});

test("Normal user with fresh membership receives no team access", async () => {
  state.teamResult = { data: null, error: null };

  await assert.rejects(requireAdmin(), { status: 403 });
});

test("Missing team role blocks access", async () => {
  state.teamResult = { data: null, error: null };

  await assert.rejects(requireModOrAdmin(), { status: 403 });
});

test("Website ban blocks before the team-role lookup", async () => {
  state.sessionError = new AuthError(
    403,
    "Account restricted",
    "WEBSITE_BANNED"
  );

  await assert.rejects(requireAdmin(), { status: 403, code: "WEBSITE_BANNED" });
  assert.equal(state.queriedDiscordUserId, null);
});

test("Known Discord ban blocks before the team-role lookup", async () => {
  state.sessionError = new AuthError(
    403,
    "Account restricted",
    "DISCORD_BANNED"
  );

  await assert.rejects(requireAdmin(), { status: 403, code: "DISCORD_BANNED" });
  assert.equal(state.queriedDiscordUserId, null);
});

test("Revoked session blocks before the team-role lookup", async () => {
  state.sessionError = new AuthError(
    401,
    "Not authenticated",
    "NOT_AUTHENTICATED"
  );

  await assert.rejects(requireAdmin(), {
    status: 401,
    code: "NOT_AUTHENTICATED",
  });
  assert.equal(state.queriedDiscordUserId, null);
});

test("Technical team-role lookup error remains fail-closed", async () => {
  state.teamResult = { data: null, error: { code: "DB_UNAVAILABLE" } };

  await assert.rejects(requireAdmin(), { status: 503 });
});

test("Stale participation remains membership_pending for Upload and Vote", () => {
  const participation = createParticipationAccessState({
    authenticated: true,
    membershipKnown: false,
  });

  assert.equal(participation.status, "membership_pending");
  assert.equal(participation.participationEligible, false);
});

test("Real authorization denials still map to the Forbidden page", () => {
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(403, "Forbidden")),
    "/403"
  );
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(401, "Not authenticated")),
    "/403"
  );
});
