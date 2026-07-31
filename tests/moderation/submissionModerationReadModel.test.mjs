import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  table: null,
  responses: new Map(),
  calls: [],
};

function builder(table) {
  const chain = {
    select(value) {
      state.calls.push([table, "select", value]);
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

const {
  getCurrentModerationCycle,
  getLiveModerationSubmissions,
  getDisqualifiedModerationSubmissions,
} = await import("../../lib/moderation/submissionModerationReadModel.ts");

test.beforeEach(() => {
  state.table = null;
  state.calls = [];
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
