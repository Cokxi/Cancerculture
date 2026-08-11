import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const VIEWER_ID = "223456789012345678";
const OTHER_OWNER_ID = "323456789012345678";
const CYCLE_ID = 7;

const state = {
  calls: [],
  decodedCursor: null,
  logCalls: [],
  rpcCalls: [],
  sessionState: { status: "anonymous" },
  submissionRows: [],
  voteRows: [],
};

function filteredRows(table, filters) {
  const rows =
    table === "submissions"
      ? state.submissionRows
      : table === "votes"
        ? state.voteRows
        : [];

  return rows.filter((row) =>
    filters.every((filter) => {
      if (filter.kind === "eq") {
        return row[filter.column] === filter.value;
      }

      if (filter.kind === "gt") {
        return row[filter.column] > filter.value;
      }

      if (filter.kind === "in") {
        return filter.values.includes(row[filter.column]);
      }

      return true;
    })
  );
}

function builder(table) {
  const filters = [];
  let limit = null;

  const chain = {
    select(columns) {
      state.calls.push([table, "select", columns]);
      return chain;
    },
    eq(column, value) {
      state.calls.push([table, "eq", column, value]);
      filters.push({ kind: "eq", column, value });
      return chain;
    },
    gt(column, value) {
      state.calls.push([table, "gt", column, value]);
      filters.push({ kind: "gt", column, value });
      return chain;
    },
    in(column, values) {
      state.calls.push([table, "in", column, values]);
      filters.push({ kind: "in", column, values });
      return chain;
    },
    or(expression) {
      state.calls.push([table, "or", expression]);
      return chain;
    },
    order(column, options) {
      state.calls.push([table, "order", column, options]);
      return chain;
    },
    limit(value) {
      state.calls.push([table, "limit", value]);
      limit = value;
      return chain;
    },
    single() {
      return Promise.resolve({
        data: filteredRows(table, filters)[0] ?? null,
        error: null,
      });
    },
    maybeSingle() {
      return Promise.resolve({
        data: filteredRows(table, filters)[0] ?? null,
        error: null,
      });
    },
    then(resolve, reject) {
      const rows = filteredRows(table, filters);
      return Promise.resolve({
        data: limit === null ? rows : rows.slice(0, limit),
        error: null,
      }).then(resolve, reject);
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
      rpc(name, args) {
        state.rpcCalls.push([name, args]);
        return Promise.resolve({
          data: {
            voteCount: 1,
            votesPerUser: 2,
            hasVoted: false,
          },
          error: null,
        });
      },
    },
  },
});

mock.module(new URL("../../lib/r2/getPublicImageUrl.ts", import.meta.url), {
  namedExports: {
    getPublicImageUrl(key) {
      return key ? `https://images.example/${key}` : undefined;
    },
  },
});

mock.module(
  new URL(
    "../../lib/pagination/getPublicPaginationErrorResponse.ts",
    import.meta.url
  ),
  {
    namedExports: {
      getPublicPaginationErrorResponse() {
        return Response.json(
          { error: "Unable to load submissions" },
          {
            status: 500,
            headers: { "Cache-Control": "no-store" },
          }
        );
      },
    },
  }
);

mock.module(
  new URL(
    "../../lib/pagination/publicPaginationCursor.server.ts",
    import.meta.url
  ),
  {
    namedExports: {
      decodeServerPublicPaginationCursor() {
        return state.decodedCursor;
      },
      encodeServerPublicPaginationCursor() {
        return "opaque-next-cursor";
      },
    },
  }
);

mock.module(new URL("../../lib/auth/sessionState.ts", import.meta.url), {
  namedExports: {
    getSessionState() {
      return Promise.resolve(state.sessionState);
    },
  },
});

mock.module(new URL("../../lib/cycles/currentCycle.ts", import.meta.url), {
  namedExports: {
    getCurrentPublicCycle() {
      return Promise.resolve({ id: CYCLE_ID, status: "voting_open" });
    },
  },
});

mock.module(
  new URL("../../lib/auth/participationGuard.ts", import.meta.url),
  {
    namedExports: {
      requireParticipation() {
        return Promise.resolve({
          membership: { status: "eligible" },
          session: { discord_user_id: VIEWER_ID },
        });
      },
    },
  }
);

mock.module(
  new URL("../../lib/turnstile/verify.server.ts", import.meta.url),
  {
    namedExports: {
      verifyTurnstileRequest() {
        return Promise.resolve({ status: "verified" });
      },
    },
  }
);

mock.module(
  new URL("../../lib/vote/getVoteEligibility.ts", import.meta.url),
  {
    namedExports: {
      getVoteEligibility() {
        return Promise.resolve({
          activeCycleId: CYCLE_ID,
          hasVoted: false,
          isBanned: false,
          voteCount: 0,
          votesPerUser: 2,
        });
      },
    },
  }
);

mock.module(new URL("../../lib/logging/logVote.ts", import.meta.url), {
  namedExports: {
    logVote(entry) {
      state.logCalls.push(entry);
      return Promise.resolve();
    },
  },
});

mock.module(new URL("../../lib/logging/touchUserLog.ts", import.meta.url), {
  namedExports: {
    touchUserLog() {
      return Promise.resolve();
    },
  },
});

const { GET: getPublicVoteSubmissions } = await import(
  "../../app/api/vote/submissions/route.ts"
);
const { POST: castVote } = await import("../../app/api/vote/route.ts");
const { getVoteSubmissionById } = await import(
  "../../lib/vote/getVoteSubmissions.ts"
);

const source = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function setVisibleSubmissions() {
  state.submissionRows = [
    {
      id: 11,
      cycle_id: CYCLE_ID,
      r2_key: "submission-11.webp",
      discord_user_id: VIEWER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
    {
      id: 12,
      cycle_id: CYCLE_ID,
      r2_key: "submission-12.webp",
      discord_user_id: OTHER_OWNER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
  ];
  state.voteRows = [
    {
      cycle_id: CYCLE_ID,
      submission_id: 12,
      discord_user_id: "423456789012345678",
    },
  ];
}

test.beforeEach(() => {
  state.calls = [];
  state.decodedCursor = null;
  state.logCalls = [];
  state.rpcCalls = [];
  state.sessionState = { status: "anonymous" };
  setVisibleSubmissions();
});

test("the authenticated public response marks only the viewer's Submission without identity data", async () => {
  state.sessionState = {
    status: "authenticated",
    session: { discord_user_id: VIEWER_ID },
  };

  const response = await getPublicVoteSubmissions(
    new Request(`https://example.test/api/vote/submissions?cycleId=${CYCLE_ID}`)
  );
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(payload.items, [
    {
      id: 11,
      image_url: "https://images.example/submission-11.webp",
      vote_count: 0,
      isOwnSubmission: true,
    },
    {
      id: 12,
      image_url: "https://images.example/submission-12.webp",
      vote_count: 1,
      isOwnSubmission: false,
    },
  ]);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), [
    "id",
    "image_url",
    "isOwnSubmission",
    "vote_count",
  ]);
  assert.doesNotMatch(serialized, /discord|user.?id|owner/iu);
  assert.doesNotMatch(serialized, new RegExp(VIEWER_ID, "u"));
  assert.doesNotMatch(serialized, new RegExp(OTHER_OWNER_ID, "u"));
});

test("anonymous and ordinary other-user Submissions remain public without ownership leakage", async () => {
  const response = await getPublicVoteSubmissions(
    new Request(`https://example.test/api/vote/submissions?cycleId=${CYCLE_ID}`)
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.items.map((submission) => ({
      id: submission.id,
      isOwnSubmission: submission.isOwnSubmission,
    })),
    [
      { id: 11, isOwnSubmission: false },
      { id: 12, isOwnSubmission: false },
    ]
  );
  assert.equal(payload.items[1].vote_count, 1);
  assert.equal(payload.items[1].image_url.endsWith("submission-12.webp"), true);
});

test("a cursor page derives ownership without exposing the viewer identity", async () => {
  state.sessionState = {
    status: "authenticated",
    session: { discord_user_id: OTHER_OWNER_ID },
  };
  state.decodedCursor = { values: { id: 11 } };

  const response = await getPublicVoteSubmissions(
    new Request(
      `https://example.test/api/vote/submissions?cycleId=${CYCLE_ID}&cursor=opaque`
    )
  );
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.deepEqual(payload.items, [
    {
      id: 12,
      image_url: "https://images.example/submission-12.webp",
      vote_count: 1,
      isOwnSubmission: true,
    },
  ]);
  assert.doesNotMatch(serialized, /discord|user.?id|owner/iu);
  assert.doesNotMatch(serialized, new RegExp(OTHER_OWNER_ID, "u"));
});

test("the direct Submission loader derives ownership for own and other Deep Links", async () => {
  const ownSubmission = await getVoteSubmissionById({
    cycleId: CYCLE_ID,
    submissionId: 11,
    viewerDiscordUserId: VIEWER_ID,
  });
  const otherSubmission = await getVoteSubmissionById({
    cycleId: CYCLE_ID,
    submissionId: 12,
    viewerDiscordUserId: VIEWER_ID,
  });

  assert.deepEqual(ownSubmission, {
    id: 11,
    image_url: "https://images.example/submission-11.webp",
    vote_count: 0,
    isOwnSubmission: true,
  });
  assert.deepEqual(otherSubmission, {
    id: 12,
    image_url: "https://images.example/submission-12.webp",
    vote_count: 1,
    isOwnSubmission: false,
  });
  assert.doesNotMatch(
    JSON.stringify([ownSubmission, otherSubmission]),
    /discord|user.?id|owner/iu
  );
});

test("viewer dependency failures do not mislabel ownership", async () => {
  state.sessionState = { status: "dependency_unavailable" };

  const response = await getPublicVoteSubmissions(
    new Request(`https://example.test/api/vote/submissions?cycleId=${CYCLE_ID}`)
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(payload, { error: "Viewer state temporarily unavailable" });
});

test("the Vote endpoint still rejects a self-vote before the atomic RPC", async () => {
  state.submissionRows = [
    {
      id: 11,
      cycle_id: CYCLE_ID,
      r2_key: "submission-11.webp",
      discord_user_id: VIEWER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
  ];
  const formData = new FormData();
  formData.set("submissionId", "11");

  const response = await castVote(
    new Request("https://example.test/api/vote", {
      method: "POST",
      body: formData,
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(payload, {
    error: "You cannot vote for your own submission",
  });
  assert.equal(state.rpcCalls.length, 0);
  assert.deepEqual(state.logCalls, [
    {
      cycleId: CYCLE_ID,
      submissionId: 11,
      discordUserId: VIEWER_ID,
      status: "rejected",
      reason: "self_vote",
    },
  ]);
});

test("multiple own Submissions are all marked and each self-vote is rejected before RPC", async () => {
  state.sessionState = {
    status: "authenticated",
    session: { discord_user_id: VIEWER_ID },
  };
  state.submissionRows = [
    {
      id: 11,
      cycle_id: CYCLE_ID,
      r2_key: "submission-11.webp",
      discord_user_id: VIEWER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
    {
      id: 13,
      cycle_id: CYCLE_ID,
      r2_key: "submission-13.webp",
      discord_user_id: VIEWER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
    {
      id: 12,
      cycle_id: CYCLE_ID,
      r2_key: "submission-12.webp",
      discord_user_id: OTHER_OWNER_ID,
      public_visibility_status: "visible",
      is_disqualified: false,
    },
  ];

  const listResponse = await getPublicVoteSubmissions(
    new Request(`https://example.test/api/vote/submissions?cycleId=${CYCLE_ID}`)
  );
  const listPayload = await listResponse.json();
  assert.deepEqual(
    listPayload.items.map(({ id, isOwnSubmission }) => ({
      id,
      isOwnSubmission,
    })),
    [
      { id: 11, isOwnSubmission: true },
      { id: 13, isOwnSubmission: true },
      { id: 12, isOwnSubmission: false },
    ]
  );

  for (const submissionId of [11, 13]) {
    const formData = new FormData();
    formData.set("submissionId", String(submissionId));
    const response = await castVote(
      new Request("https://example.test/api/vote", {
        method: "POST",
        body: formData,
      })
    );
    assert.equal(response.status, 403);
  }
  assert.equal(state.rpcCalls.length, 0);
});

test("all active application vote bounds use the expanded maximum 50", async () => {
  const [eligibility, page, transitions, action, controls, refund] =
    await Promise.all([
      source("lib/vote/getVoteEligibility.ts"),
      source("app/submissions/page.tsx"),
      source("lib/cycles/phaseTransitions.ts"),
      source("app/admin/cycles/phaseActions.ts"),
      source("app/admin/cycles/CycleHudControls.tsx"),
      source("lib/voteRefund/request.ts"),
    ]);

  for (const activeSource of [
    eligibility,
    page,
    transitions,
    action,
    controls,
    refund,
  ]) {
    assert.match(activeSource, /50/u);
    assert.doesNotMatch(
      activeSource,
      /expectedVotesPerUser\) > 10|MAX_VOTES_PER_USER = 10|max=\{10\}|Math\.min\([^\n]*, 10\)/u
    );
  }
});

test("the public DTO and client carry only isOwnSubmission while server enforcement remains atomic", async () => {
  const [
    publicType,
    loader,
    apiRoute,
    page,
    client,
    voteRoute,
    currentVoteMigration,
  ] = await Promise.all([
    source("lib/vote/publicVoteSubmission.ts"),
    source("lib/vote/getVoteSubmissions.ts"),
    source("app/api/vote/submissions/route.ts"),
    source("app/submissions/page.tsx"),
    source("app/submissions/SubmissionsClient.tsx"),
    source("app/api/vote/route.ts"),
    source(
      "supabase/migrations/20260717000300_live_catchup_cycle_infrastructure.sql"
    ),
  ]);
  const latestCastVote = currentVoteMigration.slice(
    currentVoteMigration.lastIndexOf(
      "create or replace function public.cast_cycle_vote"
    )
  );

  assert.match(publicType, /isOwnSubmission: boolean/u);
  assert.doesNotMatch(publicType, /discord|owner.*id|user.*id/iu);
  assert.match(loader, /submission\.discord_user_id === viewerDiscordUserId/u);
  assert.match(apiRoute, /getSessionState\(\)/u);
  assert.match(apiRoute, /viewerDiscordUserId:/u);
  assert.match(page, /viewerDiscordUserId: discordUserId/u);
  assert.match(page, /isAuthenticated=\{discordUserId !== null\}/u);
  assert.doesNotMatch(client, /discord_user_id|discordUserId/u);
  assert.match(client, /active\.isOwnSubmission/u);
  assert.match(client, /s\.isOwnSubmission/u);

  const serverPrecheck = voteRoute.indexOf(
    "submission.discord_user_id === discordUserId"
  );
  const atomicRpc = voteRoute.indexOf('rpc("cast_cycle_vote"');
  assert.ok(serverPrecheck > -1);
  assert.ok(atomicRpc > serverPrecheck);
  assert.match(latestCastVote, /security definer/u);
  assert.match(latestCastVote, /set search_path = public, pg_temp/u);
  assert.match(
    latestCastVote,
    /submission_row\.discord_user_id = p_discord_user_id[\s\S]*message = 'SELF_VOTE'/u
  );
  assert.match(
    latestCastVote,
    /grant execute on function public\.cast_cycle_vote\(bigint, bigint, text\)[\s\S]*to service_role/u
  );
});
