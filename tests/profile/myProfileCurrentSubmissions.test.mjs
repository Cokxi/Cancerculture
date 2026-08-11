import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  inCalls: [],
  orderCalls: [],
  rows: [],
};

function privateDataQuery() {
  const query = {
    select() {
      return query;
    },
    in(column, values) {
      state.inCalls.push([column, values]);
      return query;
    },
    order(column, options) {
      state.orderCalls.push([column, options]);
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve({ data: state.rows, error: null }).then(
        resolve,
        reject
      );
    },
  };
  return query;
}

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "submission_private_data");
        return privateDataQuery();
      },
    },
  },
});

const { getSubmissionPrivateDataBatch } = await import(
  "../../lib/submissions/getSubmissionPrivateData.ts"
);

test.beforeEach(() => {
  state.inCalls = [];
  state.orderCalls = [];
  state.rows = [
    {
      id: 90,
      submission_id: 202,
      x_username: "second",
      wallet_address: "wallet-second",
      payout_choice: "donate",
      split_percent: null,
      charity: "Second charity",
    },
    {
      id: 80,
      submission_id: 101,
      x_username: "first",
      wallet_address: "wallet-first",
      payout_choice: "keep",
      split_percent: null,
      charity: null,
    },
  ];
});

test("private payout rows are batch-loaded once and paired strictly by Submission ID", async () => {
  const result = await getSubmissionPrivateDataBatch([101, 202, 101]);

  assert.deepEqual(state.inCalls, [["submission_id", [101, 202]]]);
  assert.deepEqual(state.orderCalls, [["id", { ascending: false }]]);
  assert.equal(result.size, 2);
  assert.equal(result.get(101)?.wallet_address, "wallet-first");
  assert.equal(result.get(101)?.payout_choice, "keep");
  assert.equal(result.get(202)?.wallet_address, "wallet-second");
  assert.equal(result.get(202)?.payout_choice, "donate");
});

test("private batch input is bounded to the contractual maximum 20", async () => {
  await getSubmissionPrivateDataBatch(
    Array.from({ length: 25 }, (_, index) => index + 1)
  );

  assert.equal(state.inCalls.length, 1);
  assert.equal(state.inCalls[0][1].length, 20);
});
