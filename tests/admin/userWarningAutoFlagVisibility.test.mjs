import assert from "node:assert/strict";
import { mock, test } from "node:test";

const actorId = "111111111111111111";
const targetId = "222222222222222222";
const caseId = "018f0ed0-5c89-4c0f-9c38-8cebd4e18431";
const state = { calls: [], data: null, error: null, capabilities: [] };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return Promise.resolve({ data: state.data, error: state.error });
      },
    },
  },
});

mock.module(new URL("../../lib/auth/teamAuthorization.ts", import.meta.url), {
  namedExports: {
    async requireDynamicTeamCapability(capability) {
      state.capabilities.push(capability);
      return { discord_user_id: actorId, role: "admin", isAdmin: true };
    },
    async getTeamAuthorizationContext() {
      return { discord_user_id: actorId, role: "admin", isAdmin: true };
    },
    hasResolvedTeamCapability() {
      return true;
    },
  },
});

const { listUserWarningAutoFlagCases } = await import(
  "../../lib/admin/userFlagCases.ts"
);

function automaticCase(overrides = {}) {
  return {
    caseId,
    discordUserId: targetId,
    userDisplayName: "Member",
    generation: 1,
    status: "open",
    activeWarningCount: 3,
    triggeredByActiveCount: true,
    triggeredByFourteenDay: false,
    openedAt: "2026-08-26T12:00:00.000Z",
    closedAt: null,
    rowVersion: 2,
    events: [
      {
        eventId: "1",
        eventType: "opened",
        activeWarningCount: 3,
        triggeredByActiveCount: true,
        triggeredByFourteenDay: false,
        caseVersion: 1,
        occurredAt: "2026-08-26T12:00:00.000Z",
        recordedAt: "2026-08-26T12:00:00.000Z",
      },
      {
        eventId: "2",
        eventType: "recomputed",
        activeWarningCount: 3,
        triggeredByActiveCount: true,
        triggeredByFourteenDay: false,
        caseVersion: 2,
        occurredAt: "2026-08-26T13:00:00.000Z",
        recordedAt: "2026-08-26T13:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.data = null;
  state.error = null;
  state.capabilities = [];
});

test("automatic Warning flags use only users.flag.view and the dedicated read RPC", async () => {
  state.data = { items: [automaticCase()], total: 1, limit: 25, offset: 0 };
  const page = await listUserWarningAutoFlagCases({
    section: "active",
    limit: 25,
  });
  assert.equal(page.items[0].events[1].eventType, "recomputed");
  assert.deepEqual(state.capabilities, ["users.flag.view"]);
  assert.deepEqual(state.calls, [{
    name: "list_user_warning_auto_flag_cases",
    parameters: {
      p_actor_discord_user_id: actorId,
      p_section: "active",
      p_query: null,
      p_limit: 25,
      p_offset: 0,
    },
  }]);
  assert.doesNotMatch(JSON.stringify(page), /reason|comment|actor|warningId|source/iu);
});

test("closed automatic history preserves opened, recomputed and closed events", async () => {
  const opened = automaticCase().events[0];
  const recomputed = automaticCase().events[1];
  state.data = {
    items: [automaticCase({
      status: "closed",
      activeWarningCount: 0,
      triggeredByActiveCount: false,
      triggeredByFourteenDay: false,
      closedAt: "2026-08-26T14:00:00.000Z",
      rowVersion: 3,
      events: [opened, recomputed, {
        eventId: "3",
        eventType: "closed",
        activeWarningCount: 0,
        triggeredByActiveCount: false,
        triggeredByFourteenDay: false,
        caseVersion: 3,
        occurredAt: "2026-08-26T14:00:00.000Z",
        recordedAt: "2026-08-26T14:00:00.000Z",
      }],
    })],
    total: 26,
    limit: 25,
    offset: 25,
  };
  const page = await listUserWarningAutoFlagCases({
    section: "history",
    query: "member",
    limit: 25,
    offset: 25,
  });
  assert.deepEqual(
    page.items[0].events.map((event) => event.eventType),
    ["opened", "recomputed", "closed"],
  );
  assert.equal(page.items[0].status, "closed");
});

test("extra keys, impossible trigger state and truncated lifecycle fail closed", async () => {
  for (const invalidCase of [
    { ...automaticCase(), internalWarningId: "must not pass" },
    automaticCase({ triggeredByActiveCount: false }),
    automaticCase({ events: [automaticCase().events[0]] }),
  ]) {
    state.data = { items: [invalidCase], total: 1, limit: 25, offset: 0 };
    await assert.rejects(
      listUserWarningAutoFlagCases({ section: "active", limit: 25 }),
      (error) => error.status === 503,
    );
  }
});
