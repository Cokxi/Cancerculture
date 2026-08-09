import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  table: null,
  responses: new Map(),
  calls: [],
  authorizationCalls: [],
};

function builder(table) {
  const chain = {
    select(value, options) {
      state.calls.push([table, "select", value, options]);
      return chain;
    },
    in(column, values) {
      state.calls.push([table, "in", column, values]);
      return chain;
    },
    eq(column, value) {
      state.calls.push([table, "eq", column, value]);
      return chain;
    },
    order(column, options) {
      state.calls.push([table, "order", column, options]);
      return chain;
    },
    limit(value) {
      state.calls.push([table, "limit", value]);
      return chain;
    },
    range(from, to) {
      state.calls.push([table, "range", from, to]);
      return chain;
    },
    then(resolve, reject) {
      return Promise.resolve(
        state.responses.get(table) ?? { data: [], error: null }
      ).then(resolve, reject);
    },
  };
  return chain;
}

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        state.table = table;
        return builder(table);
      },
    },
  },
});

mock.module(new URL("../../lib/auth/teamAuthorization.ts", import.meta.url), {
  namedExports: {
    requireDynamicTeamCapability(capability) {
      state.authorizationCalls.push(capability);
      return Promise.resolve({
        discord_user_id: "cycle-manager",
        isAdmin: false,
        resolvedCapabilities: [capability],
      });
    },
  },
});

const {
  getCurrentModerationCycle,
  getLiveModerationSubmissions,
  getDisqualifiedModerationSubmissions,
  loadCycleEndModerationReadModel,
} = await import("../../lib/moderation/submissionModerationReadModel.ts");

test.beforeEach(() => {
  state.table = null;
  state.calls = [];
  state.authorizationCalls = [];
  state.responses = new Map();
});

test("the current-cycle read accepts submission_open and voting_open only", async () => {
  for (const status of ["submission_open", "voting_open"]) {
    state.responses.set("voting_cycles", {
      data: [{ id: 7, status }],
      error: null,
    });
    assert.deepEqual(await getCurrentModerationCycle(), {
      id: 7,
      status,
    });
  }
  assert.deepEqual(
    state.calls.find((entry) => entry[1] === "in"),
    [
      "voting_cycles",
      "in",
      "status",
      ["submission_open", "voting_open"],
    ]
  );
});

test("cycle query and invariant failures are 503 rather than an empty cycle", async () => {
  state.responses.set("voting_cycles", {
    data: null,
    error: { code: "DB_UNAVAILABLE" },
  });
  await assert.rejects(
    getCurrentModerationCycle(),
    (error) => error?.status === 503 &&
      error?.code === "MODERATION_CYCLE_READ_UNAVAILABLE"
  );

  state.responses.set("voting_cycles", {
    data: [
      { id: 7, status: "submission_open" },
      { id: 8, status: "voting_open" },
    ],
    error: null,
  });
  await assert.rejects(
    getCurrentModerationCycle(),
    (error) => error?.status === 503 &&
      error?.code === "MODERATION_CYCLE_INVARIANT_BROKEN"
  );
});

test("submission query failures are controlled 503 errors", async () => {
  state.responses.set("submissions", {
    data: null,
    error: { code: "DB_UNAVAILABLE" },
  });
  for (const load of [
    getLiveModerationSubmissions,
    getDisqualifiedModerationSubmissions,
  ]) {
    await assert.rejects(
      load(7),
      (error) => error?.status === 503 &&
        error?.code === "MODERATION_SUBMISSION_READ_UNAVAILABLE"
    );
  }
});

test("Live Moderation can load one focused Submission without scanning the first 50", async () => {
  state.responses.set("submissions", {
    data: [{ id: 125, cycle_id: 7 }],
    error: null,
  });

  const result = await getLiveModerationSubmissions(7, 125);

  assert.equal(result.length, 1);
  assert.deepEqual(
    state.calls.filter(
      (entry) => entry[0] === "submissions" && entry[1] === "eq"
    ),
    [
      ["submissions", "eq", "cycle_id", 7],
      ["submissions", "eq", "id", 125],
    ]
  );
  assert.deepEqual(
    state.calls.find((entry) => entry[1] === "limit"),
    ["submissions", "limit", 1]
  );
});

test("Cycle End Moderation read model authorizes before loading all paginated submissions", async () => {
  state.responses.set("voting_cycles", {
    data: [{ id: 7, status: "voting_closed" }],
    error: null,
  });
  state.responses.set("submissions", {
    data: [
      {
        id: 125,
        cycle_id: 7,
        r2_key: "submissions/125.webp",
        is_disqualified: false,
        discord_user_id: "submitter",
      },
    ],
    error: null,
    count: 49,
  });

  const result = await loadCycleEndModerationReadModel(2);

  assert.deepEqual(state.authorizationCalls, ["cycles.manage"]);
  assert.equal(result.cycle?.status, "voting_closed");
  assert.equal(result.submissions?.items.length, 1);
  assert.equal(result.submissions?.hasPrevious, true);
  assert.equal(result.submissions?.hasNext, false);
  assert.deepEqual(
    state.calls.find((entry) => entry[1] === "range"),
    ["submissions", "range", 48, 95]
  );
});

test("Cycle End Moderation can load one focused Submission independently of pagination", async () => {
  state.responses.set("voting_cycles", {
    data: [{ id: 7, status: "voting_closed" }],
    error: null,
  });
  state.responses.set("submissions", {
    data: [{ id: 125, cycle_id: 7 }],
    error: null,
    count: 1,
  });

  const result = await loadCycleEndModerationReadModel(3, 125);

  assert.deepEqual(state.authorizationCalls, ["cycles.manage"]);
  assert.equal(result.submissions?.page, 1);
  assert.equal(result.submissions?.hasPrevious, false);
  assert.equal(result.submissions?.hasNext, false);
  assert.deepEqual(
    state.calls.filter(
      (entry) => entry[0] === "submissions" && entry[1] === "eq"
    ),
    [
      ["submissions", "eq", "cycle_id", 7],
      ["submissions", "eq", "id", 125],
    ]
  );
  assert.deepEqual(
    state.calls.find((entry) => entry[1] === "range"),
    ["submissions", "range", 0, 0]
  );
});
