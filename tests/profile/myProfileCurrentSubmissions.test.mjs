import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const myProfilePage = await readFile(
  new URL("../../app/my-profile/page.tsx", import.meta.url),
  "utf8"
);

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

test("Current Cycle cards wrap responsively and fail closed for Profile Wallet and Wallet Issue state", () => {
  assert.match(
    myProfilePage,
    /<div className="relative left-1\/2 w-\[calc\(100vw-2rem\)\] max-w-\[120rem\][^"]*">[\s\S]*?<h2[\s\S]*?Current Cycle/u
  );
  assert.match(
    myProfilePage,
    /<div className="space-y-4">\s*<ProfileSocialsSection/u
  );
  assert.match(
    myProfilePage,
    /flex flex-wrap justify-center gap-4/u
  );
  assert.match(
    myProfilePage,
    /flex w-full min-w-0 max-w-lg basis-\[28rem\] grow flex-col/u
  );
  assert.match(myProfilePage, /mx-auto w-full max-w-5xl rounded-lg/u);
  assert.doesNotMatch(
    myProfilePage,
    /grid-cols-\[repeat\(auto-fit|minmax\(min\(100%,28rem\),1fr\)/u
  );
  assert.match(
    myProfilePage,
    /\{showWalletAddress && \([\s\S]*overflow-x-auto whitespace-nowrap[\s\S]*\[scrollbar-width:none\][\s\S]*title=\{privateData\.wallet_address\}[\s\S]*tabIndex=\{0\}/u
  );
  assert.match(myProfilePage, /getSolProfileWallet\(session\)\.catch\(\(\) => undefined\)/u);
  assert.match(
    myProfilePage,
    /profileWallet\?\.factorActive === true &&[\s\S]*profileWallet\.walletAddress !== null/u
  );
  assert.match(
    myProfilePage,
    /showWalletAddress=\{profileWalletAvailable && !hasSavedProfileWallet\}/u
  );
  assert.match(
    myProfilePage,
    /walletIssueIntakeAllowed=\{walletIssueIntakeAllowed\}/u
  );
  assert.doesNotMatch(myProfilePage, /gap-4 sm:grid-cols-2/u);
});
