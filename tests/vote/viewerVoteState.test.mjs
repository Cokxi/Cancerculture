import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const state = {
  calls: [],
  response: { data: [], error: null },
};

function builder(table) {
  const chain = {
    select(columns) {
      state.calls.push([table, "select", columns]);
      return chain;
    },
    eq(column, value) {
      state.calls.push([table, "eq", column, value]);
      return chain;
    },
    then(resolve, reject) {
      return Promise.resolve(state.response).then(resolve, reject);
    },
  };
  return chain;
}

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        return builder(table);
      },
    },
  },
});

const {
  getViewerVoteState,
  ViewerVoteStateUnavailableError,
} = await import("../../lib/vote/viewerVoteState.server.ts");

test.beforeEach(() => {
  state.calls = [];
  state.response = { data: [], error: null };
});

test("viewer vote state reads only the current viewer's submission ids", async () => {
  state.response = {
    data: [{ submission_id: 19 }, { submission_id: 7 }],
    error: null,
  };

  const result = await getViewerVoteState({
    cycleId: 9,
    discordUserId: " viewer-1 ",
  });

  assert.deepEqual(result, {
    voteCount: 2,
    votedSubmissionIds: [7, 19],
  });
  assert.deepEqual(state.calls, [
    ["votes", "select", "submission_id"],
    ["votes", "eq", "cycle_id", 9],
    ["votes", "eq", "discord_user_id", "viewer-1"],
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.votedSubmissionIds), true);
});

test("viewer vote state rejects invalid input before querying", async () => {
  await assert.rejects(
    getViewerVoteState({ cycleId: 0, discordUserId: "viewer-1" }),
    TypeError
  );
  await assert.rejects(
    getViewerVoteState({ cycleId: 9, discordUserId: " " }),
    TypeError
  );
  assert.deepEqual(state.calls, []);
});

test("viewer vote-state dependencies fail closed without inventing zero votes", async () => {
  state.response = { data: null, error: { code: "DB_UNAVAILABLE" } };
  await assert.rejects(
    getViewerVoteState({ cycleId: 9, discordUserId: "viewer-1" }),
    (error) =>
      error instanceof ViewerVoteStateUnavailableError &&
      error.code === "VIEWER_VOTE_STATE_UNAVAILABLE"
  );

  state.response = { data: [{ submission_id: null }], error: null };
  await assert.rejects(
    getViewerVoteState({ cycleId: 9, discordUserId: "viewer-1" }),
    ViewerVoteStateUnavailableError
  );
});

test("submissions load the lightweight vote state without moving it into the global account", async () => {
  const [page, client, globalAccount, accountRoute] = await Promise.all([
    readFile(new URL("../../app/submissions/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../../app/submissions/SubmissionsClient.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../app/components/auth/GlobalAccount.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../app/api/auth/account/route.ts", import.meta.url),
      "utf8"
    ),
  ]);

  assert.match(page, /getViewerVoteState/u);
  assert.match(page, /viewerVoteStatePromise/u);
  assert.doesNotMatch(page, /hasVoted=\{false\}/u);
  assert.doesNotMatch(page, /voteCount=\{0\}/u);
  assert.doesNotMatch(page, /votedSubmissionIds=\{\[\]\}/u);
  assert.match(client, /initialVoteStateAvailable/u);
  assert.match(client, /VOTE STATUS UNAVAILABLE/u);
  assert.doesNotMatch(
    `${globalAccount}\n${accountRoute}`,
    /getViewerVoteState|viewerVoteState/u
  );
});
