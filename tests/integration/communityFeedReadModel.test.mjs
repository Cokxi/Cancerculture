import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  calls: [],
  cycles: [],
  cycleSnapshots: null,
  submissions: [],
  results: [],
  decodedLive: null,
  liveCursorError: null,
  decodedFinalized: null,
  encoded: [],
};

function relatedRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function valueAt(row, column) {
  const [relation, field] = column.split(".");

  if (!field) return row[column];
  return relatedRow(row[relation])?.[field];
}

function compareValues(left, right, ascending) {
  if (left === right) return 0;
  if (left === null || left === undefined) return ascending ? -1 : 1;
  if (right === null || right === undefined) return ascending ? 1 : -1;
  return (left < right ? -1 : 1) * (ascending ? 1 : -1);
}

function builder(table) {
  const filters = [];
  const orders = [];
  let rowLimit = null;

  function execute() {
    const source =
      table === "voting_cycles"
        ? state.cycleSnapshots
          ? state.cycleSnapshots.length > 1
            ? state.cycleSnapshots.shift()
            : state.cycleSnapshots[0]
          : state.cycles
        : table === "submissions"
          ? state.submissions
          : state.results;
    let rows = source.filter((row) =>
      filters.every((filter) => {
        if (filter.kind === "dq") {
          const target = filter.relation
            ? relatedRow(row[filter.relation])
            : row;
          return target?.is_disqualified !== true;
        }
        if (filter.kind === "live-keyset") {
          const tuple = state.decodedLive?.values;
          return (
            tuple &&
            (row.created_at < tuple.createdAt ||
              (row.created_at === tuple.createdAt &&
                row.id < tuple.submissionId))
          );
        }
        if (filter.kind === "finalized-keyset") {
          const tuple = state.decodedFinalized?.values;
          return (
            tuple &&
            (row.finalized_at < tuple.finalizedAt ||
              (row.finalized_at === tuple.finalizedAt &&
                (row.cycle_id < tuple.cycleId ||
                  (row.cycle_id === tuple.cycleId &&
                    (row.rank_in_cycle > tuple.rankInCycle ||
                      (row.rank_in_cycle === tuple.rankInCycle &&
                        row.submission_id > tuple.submissionId))))))
          );
        }

        const value = valueAt(row, filter.column);

        if (filter.kind === "eq") return value === filter.value;
        if (filter.kind === "gt") return value > filter.value;
        if (filter.kind === "lte") return value <= filter.value;
        if (filter.kind === "in") return filter.values.includes(value);
        if (filter.kind === "not-null") return value !== null && value !== undefined;

        return true;
      }),
    );

    rows = [...rows].sort((left, right) => {
      for (const order of orders) {
        const comparison = compareValues(
          valueAt(left, order.column),
          valueAt(right, order.column),
          order.ascending,
        );
        if (comparison !== 0) return comparison;
      }
      return 0;
    });

    if (rowLimit !== null) rows = rows.slice(0, rowLimit);
    return { data: rows, error: null };
  }

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
    lte(column, value) {
      state.calls.push([table, "lte", column, value]);
      filters.push({ kind: "lte", column, value });
      return chain;
    },
    in(column, values) {
      state.calls.push([table, "in", column, values]);
      filters.push({ kind: "in", column, values });
      return chain;
    },
    not(column, operator, value) {
      state.calls.push([table, "not", column, operator, value]);
      if (operator === "is" && value === null) {
        filters.push({ kind: "not-null", column });
      }
      return chain;
    },
    or(expression, options = {}) {
      state.calls.push([table, "or", expression, options]);
      if (expression.startsWith("is_disqualified")) {
        filters.push({
          kind: "dq",
          relation: options.referencedTable ?? null,
        });
      } else if (expression.startsWith("created_at")) {
        filters.push({ kind: "live-keyset" });
      } else if (expression.startsWith("finalized_at")) {
        filters.push({ kind: "finalized-keyset" });
      }
      return chain;
    },
    order(column, options) {
      state.calls.push([table, "order", column, options]);
      orders.push({ column, ascending: options.ascending });
      return chain;
    },
    limit(value) {
      state.calls.push([table, "limit", value]);
      rowLimit = value;
      return chain;
    },
    maybeSingle() {
      const result = execute();
      return Promise.resolve({
        data: result.data[0] ?? null,
        error: result.error,
      });
    },
    then(resolve, reject) {
      return Promise.resolve(execute()).then(resolve, reject);
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

mock.module(new URL("../../lib/r2/getPublicImageUrl.ts", import.meta.url), {
  namedExports: {
    getPublicImageUrl(key) {
      return key ? `https://images.example/${key}` : undefined;
    },
  },
});

function invalidCursor() {
  const error = new Error("INVALID_CURSOR");
  error.name = "PublicPaginationCursorError";
  return error;
}

mock.module(
  new URL("../../lib/feed/communityFeedCursor.server.ts", import.meta.url),
  {
    namedExports: {
      decodeLiveFeedCursor() {
        if (state.liveCursorError) {
          throw state.liveCursorError;
        }
        if (!state.decodedLive) {
          throw invalidCursor();
        }
        return state.decodedLive;
      },
      decodeFinalizedFeedCursor(_cursor, feed) {
        if (
          !state.decodedFinalized ||
          state.decodedFinalized.context.feed !== feed ||
          state.decodedFinalized.context.classificationVersion !== 1
        ) {
          throw invalidCursor();
        }
        return state.decodedFinalized;
      },
      encodeLiveFeedCursor(payload) {
        state.encoded.push({ kind: "live", ...payload });
        return `live:${payload.tuple.submissionId}`;
      },
      encodeFinalizedFeedCursor(payload) {
        state.encoded.push({ kind: "finalized", ...payload });
        return `${payload.feed}:${payload.tuple.submissionId}`;
      },
    },
  },
);

const {
  getCommunityFeedPage,
  resolveCommunityFeedAnchor,
  resolveCommunityFeedMediaSource,
} = await import("../../lib/feed/communityFeedReadModel.server.ts");

function currentCycle(overrides = {}) {
  return {
    id: 72,
    public_number: 14,
    reset_count: 4,
    status: "voting_open",
    ...overrides,
  };
}

function liveSubmission(index, overrides = {}) {
  const createdAt = new Date(
    Date.parse("2026-08-12T12:00:00.000Z") - index * 1000,
  ).toISOString();
  return {
    id: 1000 - index,
    cycle_id: 72,
    r2_key: `live-${index}.webp`,
    media_width: 1200,
    media_height: 900,
    created_at: createdAt,
    public_visibility_status: "visible",
    is_disqualified: false,
    discord_user_id: `private-live-${index}`,
    moderation_reason: `private-moderation-${index}`,
    ...overrides,
  };
}

function finalizedResult(index, overrides = {}) {
  const cycleId = overrides.cycle_id ?? 70;
  const submissionId = overrides.submission_id ?? 2000 + index;
  const rank = overrides.rank_in_cycle ?? index + 1;
  const submission = {
    id: submissionId,
    cycle_id: cycleId,
    r2_key: `final-${submissionId}.webp`,
    media_width: 1000,
    media_height: 800,
    created_at: new Date(
      Date.parse("2026-08-10T12:00:00.000Z") + index * 1000,
    ).toISOString(),
    public_visibility_status: "visible",
    is_disqualified: false,
    discord_user_id: `private-final-${submissionId}`,
    report_reason: `private-report-${submissionId}`,
  };
  const cycle = {
    id: cycleId,
    public_number: overrides.public_number ?? 13,
    status: "finished",
    private_sponsor_note: `private-sponsor-${cycleId}`,
  };

  return {
    cycle_id: cycleId,
    submission_id: submissionId,
    final_vote_count: overrides.final_vote_count ?? 100 - index,
    rank_in_cycle: rank,
    finalized_at:
      overrides.finalized_at ?? "2026-08-11T20:00:00.000Z",
    feed_classification_version: 1,
    feed_eligible: overrides.feed_eligible ?? true,
    feed_trash: overrides.feed_trash ?? false,
    submissions: { ...submission, ...overrides.submission },
    voting_cycles: { ...cycle, ...overrides.cycle },
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.cycles = [currentCycle()];
  state.cycleSnapshots = null;
  state.submissions = [];
  state.results = [];
  state.decodedLive = null;
  state.liveCursorError = null;
  state.decodedFinalized = null;
  state.encoded = [];
});

test("Live pagination filters hidden intermediate rows before LIMIT across multiple pages", async () => {
  const hidden = Array.from({ length: 60 }, (_, index) =>
    liveSubmission(index - 100, {
      id: 5000 + index,
      public_visibility_status: "removed",
    }),
  );
  const visible = Array.from({ length: 50 }, (_, index) =>
    liveSubmission(index, {
      created_at: liveSubmission(index).created_at.replace(
        ".000Z",
        ".000123+00:00",
      ),
    }),
  );
  state.submissions = [...hidden, ...visible];

  const first = await getCommunityFeedPage({ feed: "live" });

  assert.equal(first.items.length, 48);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, `live:${visible[47].id}`);
  assert.equal(state.encoded.at(-1).tuple.createdAt, visible[47].created_at);
  assert.deepEqual(
    first.items.map((item) => item.submissionId),
    visible.slice(0, 48).map((row) => row.id),
  );
  assert.deepEqual(first.context, {
    kind: "live",
    cycleId: 72,
    cycleNumber: 14,
    resetCount: 4,
  });

  state.decodedLive = {
    context: { feed: "live", cycleId: 72, resetCount: 4 },
    values: state.encoded.at(-1).tuple,
  };
  const second = await getCommunityFeedPage({
    feed: "live",
    cursor: first.nextCursor,
  });

  assert.equal(second.cursorState, "continued");
  assert.deepEqual(
    second.items.map((item) => item.submissionId),
    visible.slice(48).map((row) => row.id),
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.submissionId))
      .size,
    50,
  );
  assert.ok(
    state.calls.some(
      (call) =>
        call[0] === "submissions" &&
        call[1] === "eq" &&
        call[2] === "id" &&
        call[3] === visible[47].id,
    ),
  );
});

test("Top 10 keeps every Dense-Rank tie, All excludes Trash, and Trash uses only stored classification", async () => {
  state.results = [
    ...Array.from({ length: 9 }, (_, index) =>
      finalizedResult(index, { rank_in_cycle: index + 1 }),
    ),
    finalizedResult(9, { rank_in_cycle: 10, submission_id: 2101 }),
    finalizedResult(10, { rank_in_cycle: 10, submission_id: 2102 }),
    finalizedResult(11, {
      rank_in_cycle: 11,
      submission_id: 2103,
      feed_trash: true,
    }),
    finalizedResult(12, {
      rank_in_cycle: 12,
      submission_id: 2104,
      final_vote_count: 0,
      feed_eligible: false,
    }),
  ];

  const [top10, all, trash] = await Promise.all([
    getCommunityFeedPage({ feed: "top10" }),
    getCommunityFeedPage({ feed: "all" }),
    getCommunityFeedPage({ feed: "trash" }),
  ]);

  assert.equal(top10.items.length, 11);
  assert.deepEqual(
    top10.items.filter((item) => item.rankInCycle === 10).map((item) => item.submissionId),
    [2101, 2102],
  );
  assert.equal(all.items.some((item) => item.submissionId === 2103), false);
  assert.equal(all.items.some((item) => item.submissionId === 2104), false);
  assert.deepEqual(
    trash.items.map((item) => item.submissionId),
    [2103],
  );
});

test("finalized ordering and full-tuple cursors remain stable across pages", async () => {
  state.results = Array.from({ length: 50 }, (_, index) =>
    finalizedResult(index, {
      finalized_at: "2026-08-11T20:00:00.730016+00:00",
      rank_in_cycle: Math.floor(index / 2) + 1,
      submission_id: 3000 + index,
      final_vote_count: 100 - Math.floor(index / 2),
    }),
  );

  const first = await getCommunityFeedPage({ feed: "all" });
  assert.equal(first.items.length, 48);
  assert.equal(first.hasMore, true);
  const tuple = state.encoded.at(-1).tuple;
  assert.deepEqual(Object.keys(tuple).sort(), [
    "cycleId",
    "finalizedAt",
    "rankInCycle",
    "submissionId",
  ]);
  assert.equal(tuple.finalizedAt, "2026-08-11T20:00:00.730016+00:00");
  assert.equal(first.items[0].finalizedAt, "2026-08-11T20:00:00.730Z");

  state.decodedFinalized = {
    context: { feed: "all", classificationVersion: 1 },
    values: tuple,
  };
  const second = await getCommunityFeedPage({
    feed: "all",
    cursor: first.nextCursor,
  });

  assert.deepEqual(
    second.items.map((item) => item.submissionId),
    [3048, 3049],
  );
  assert.equal(second.cursorState, "continued");
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.submissionId))
      .size,
    50,
  );
});

test("a removed cursor anchor resets safely and never leaks or projects that row", async () => {
  state.results = Array.from({ length: 4 }, (_, index) =>
    finalizedResult(index, { submission_id: 4000 + index }),
  );
  const removed = state.results[1];
  removed.submissions.public_visibility_status = "removed";
  state.decodedFinalized = {
    context: { feed: "all", classificationVersion: 1 },
    values: {
      finalizedAt: removed.finalized_at,
      cycleId: removed.cycle_id,
      rankInCycle: removed.rank_in_cycle,
      submissionId: removed.submission_id,
    },
  };

  const page = await getCommunityFeedPage({
    feed: "all",
    cursor: "previously-valid",
  });

  assert.equal(page.cursorState, "anchor_unavailable_reset");
  assert.deepEqual(
    page.items.map((item) => item.submissionId),
    [4000, 4002, 4003],
  );
  assert.equal(
    page.items.some((item) => item.submissionId === removed.submission_id),
    false,
  );
});

test("semantic anchors resolve by exact ID and return only the public DTO allowlist", async () => {
  const target = finalizedResult(0, { submission_id: 5001 });
  state.results = [target];

  const resolution = await resolveCommunityFeedAnchor({
    feed: "all",
    submissionId: 5001,
  });
  const serialized = JSON.stringify(resolution);

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.resumeCursor, "all:5001");
  assert.deepEqual(Object.keys(resolution.item).sort(), [
    "createdAt",
    "cycleNumber",
    "finalVoteCount",
    "finalizedAt",
    "imageUrl",
    "mediaHeight",
    "mediaWidth",
    "rankInCycle",
    "submissionId",
  ]);
  assert.doesNotMatch(serialized, /private-final|private-report|private-sponsor/u);
  assert.doesNotMatch(serialized, /discord|moderation|report|sponsor|observation/iu);
  assert.ok(
    state.calls.some(
      (call) =>
        call[0] === "cycle_results" &&
        call[1] === "eq" &&
        call[2] === "submission_id" &&
        call[3] === 5001,
    ),
  );
  assert.equal(
    state.calls.some(
      (call) => call[0] === "cycle_results" && call[1] === "order",
    ),
    false,
  );
});

test("hidden, DQ, and missing direct anchors fail closed", async () => {
  state.results = [
    finalizedResult(0, {
      submission_id: 6001,
      submission: { public_visibility_status: "removed" },
    }),
    finalizedResult(1, {
      submission_id: 6002,
      submission: { is_disqualified: true },
    }),
  ];

  for (const submissionId of [6001, 6002, 6999]) {
    const resolution = await resolveCommunityFeedAnchor({
      feed: "all",
      submissionId,
    });
    assert.equal(resolution.status, "unavailable");
    assert.equal(resolution.item, null);
    assert.equal(resolution.resumeCursor, null);
  }
});

test("Feed media source rechecks visible, DQ, legal-review, classification, and current Live context", async () => {
  const visible = finalizedResult(0, { submission_id: 6100 });
  const hidden = finalizedResult(1, {
    submission_id: 6101,
    submission: { public_visibility_status: "removed" },
  });
  const legalReview = finalizedResult(2, {
    submission_id: 6102,
    submission: { public_visibility_status: "legal_review" },
  });
  const disqualified = finalizedResult(3, {
    submission_id: 6103,
    submission: { is_disqualified: true },
  });
  const ineligible = finalizedResult(4, {
    submission_id: 6104,
    feed_eligible: false,
  });
  state.results = [visible, hidden, legalReview, disqualified, ineligible];

  assert.deepEqual(
    await resolveCommunityFeedMediaSource({ feed: "all", submissionId: 6100 }),
    { r2Key: visible.submissions.r2_key },
  );
  for (const submissionId of [6101, 6102, 6103, 6104, 6199]) {
    assert.equal(
      await resolveCommunityFeedMediaSource({ feed: "all", submissionId }),
      null,
    );
  }

  const live = liveSubmission(0);
  state.submissions = [live];
  assert.deepEqual(
    await resolveCommunityFeedMediaSource({ feed: "live", submissionId: live.id }),
    { r2Key: live.r2_key },
  );
  state.cycles = [];
  assert.equal(
    await resolveCommunityFeedMediaSource({ feed: "live", submissionId: live.id }),
    null,
  );
});

test("submission_closed remains part of the one current Live Cycle", async () => {
  state.cycles = [currentCycle({ status: "submission_closed" })];
  state.submissions = [liveSubmission(0)];

  const page = await getCommunityFeedPage({ feed: "live" });

  assert.deepEqual(
    page.items.map((item) => item.submissionId),
    [state.submissions[0].id],
  );
  assert.equal(page.context.cycleId, 72);
});

test("valid Live cursors reset clearly after a reset-count change", async () => {
  state.submissions = [liveSubmission(0)];
  state.decodedLive = {
    context: { feed: "live", cycleId: 72, resetCount: 3 },
    values: {
      createdAt: state.submissions[0].created_at,
      submissionId: state.submissions[0].id,
    },
  };

  const page = await getCommunityFeedPage({
    feed: "live",
    cursor: "old-reset",
  });

  assert.equal(page.cursorState, "context_unavailable_reset");
  assert.deepEqual(
    page.items.map((item) => item.submissionId),
    [state.submissions[0].id],
  );
  assert.equal(
    state.calls.some(
      (call) =>
        call[0] === "submissions" &&
        call[1] === "eq" &&
        call[2] === "id",
    ),
    false,
  );
});

test("valid Live cursors reset clearly after the current Cycle changes", async () => {
  state.cycles = [
    currentCycle({ id: 73, public_number: 15, reset_count: 0 }),
  ];
  state.submissions = [liveSubmission(0, { cycle_id: 73 })];
  state.decodedLive = {
    context: { feed: "live", cycleId: 72, resetCount: 4 },
    values: {
      createdAt: "2026-08-12T12:00:00.000Z",
      submissionId: 1000,
    },
  };

  const page = await getCommunityFeedPage({
    feed: "live",
    cursor: "old-cycle",
  });

  assert.equal(page.cursorState, "context_unavailable_reset");
  assert.equal(page.context.cycleId, 73);
  assert.deepEqual(
    page.items.map((item) => item.submissionId),
    [1000],
  );
});

test("tampered Live cursors remain invalid instead of becoming context resets", async () => {
  state.liveCursorError = invalidCursor();

  await assert.rejects(
    getCommunityFeedPage({ feed: "live", cursor: "tampered" }),
    { name: "PublicPaginationCursorError", message: "INVALID_CURSOR" },
  );
});

test("ambiguous active Cycles fail closed", async () => {
  state.cycles.push(currentCycle({ id: 73, public_number: 15 }));

  await assert.rejects(getCommunityFeedPage({ feed: "live" }), {
    message: "COMMUNITY_FEED_MULTIPLE_LIVE_CYCLES",
  });
});

test("Live page reads retry once when a reset commits between context and rows", async () => {
  const beforeReset = currentCycle({ reset_count: 4 });
  const afterReset = currentCycle({ reset_count: 5 });
  state.cycleSnapshots = [
    [beforeReset],
    [afterReset],
    [afterReset],
    [afterReset],
  ];
  state.submissions = Array.from({ length: 49 }, (_, index) =>
    liveSubmission(index),
  );

  const page = await getCommunityFeedPage({ feed: "live" });

  assert.equal(page.cursorState, "context_unavailable_reset");
  assert.equal(page.context.resetCount, 5);
  assert.equal(page.items.length, 48);
  assert.equal(page.hasMore, true);
  assert.equal(state.encoded.length, 1);
  assert.equal(state.encoded[0].resetCount, 5);
});

test("direct Live anchors retry once and sign only the verified reset context", async () => {
  const beforeReset = currentCycle({ reset_count: 4 });
  const afterReset = currentCycle({ reset_count: 5 });
  const target = liveSubmission(0);
  state.cycleSnapshots = [
    [beforeReset],
    [afterReset],
    [afterReset],
    [afterReset],
  ];
  state.submissions = [target];

  const resolution = await resolveCommunityFeedAnchor({
    feed: "live",
    submissionId: target.id,
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.context.resetCount, 5);
  assert.equal(state.encoded.length, 1);
  assert.equal(state.encoded[0].resetCount, 5);
});

test("a valid stale Live cursor with no current Cycle returns an explicit safe reset", async () => {
  state.cycles = [];
  state.decodedLive = {
    context: { feed: "live", cycleId: 72, resetCount: 4 },
    values: {
      createdAt: "2026-08-12T12:00:00.000Z",
      submissionId: 1000,
    },
  };

  const page = await getCommunityFeedPage({
    feed: "live",
    cursor: "stale-live-cursor",
  });

  assert.deepEqual(page, {
    items: [],
    nextCursor: null,
    hasMore: false,
    feed: "live",
    context: null,
    cursorState: "context_unavailable_reset",
  });
});

test("a tampered Live cursor fails even when no current Cycle exists", async () => {
  state.cycles = [];
  state.liveCursorError = invalidCursor();

  await assert.rejects(
    getCommunityFeedPage({ feed: "live", cursor: "tampered" }),
    { name: "PublicPaginationCursorError", message: "INVALID_CURSOR" },
  );
});
