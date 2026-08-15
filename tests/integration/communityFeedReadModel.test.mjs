import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  calls: [],
  cycles: [],
  cycleSnapshots: null,
  submissions: [],
  results: [],
  userLogs: [],
  decodedLive: null,
  liveCursorError: null,
  decodedFinalized: null,
  decodedCatalog: null,
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
  let countRequested = false;
  let headOnly = false;

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
          : table === "user_logs"
            ? state.userLogs
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
          const cycleId = filter.cycleId;
          return (
            tuple &&
            (row.finalized_at < tuple.finalizedAt ||
              (row.finalized_at === tuple.finalizedAt &&
                (row.cycle_id < cycleId ||
                  (row.cycle_id === cycleId &&
                    (row.rank_in_cycle > tuple.rankInCycle ||
                      (row.rank_in_cycle === tuple.rankInCycle &&
                        row.submission_id > tuple.submissionId))))))
          );
        }

        const value = valueAt(row, filter.column);

        if (filter.kind === "eq") return value === filter.value;
        if (filter.kind === "gt") return value > filter.value;
        if (filter.kind === "lte") return value <= filter.value;
        if (filter.kind === "lt") return value < filter.value;
        if (filter.kind === "in") return filter.values.includes(value);
        if (filter.kind === "not-null") return value !== null && value !== undefined;

        return true;
      }),
    );

    const count = rows.length;
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
    return {
      data: headOnly ? null : rows,
      error: null,
      count: countRequested ? count : null,
    };
  }

  const chain = {
    select(columns, options = {}) {
      state.calls.push([table, "select", columns, options]);
      countRequested = options.count === "exact";
      headOnly = options.head === true;
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
    lt(column, value) {
      state.calls.push([table, "lt", column, value]);
      filters.push({ kind: "lt", column, value });
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
        const cycleId = Number(
          expression.match(/cycle_id\.lt\.(\d+)/u)?.[1],
        );
        filters.push({ kind: "finalized-keyset", cycleId });
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
        data: result.data?.[0] ?? null,
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
      decodeFinalizedFeedCursor(_cursor, feed, cycleNumber) {
        if (
          !state.decodedFinalized ||
          state.decodedFinalized.context.feed !== feed ||
          state.decodedFinalized.context.classificationVersion !== 1 ||
          state.decodedFinalized.context.cycleNumber !== cycleNumber
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
      decodeCommunityFeedCycleCatalogCursor() {
        if (!state.decodedCatalog) throw invalidCursor();
        return state.decodedCatalog;
      },
      encodeCommunityFeedCycleCatalogCursor(cycleNumber) {
        state.encoded.push({ kind: "catalog", cycleNumber });
        return `catalog:${cycleNumber}`;
      },
    },
  },
);

const {
  getCommunityFeedPage,
  resolveCommunityFeedAnchor,
  resolveCommunityFeedMediaSource,
  getCommunityFeedCycleCatalogPage,
} = await import("../../lib/feed/communityFeedReadModel.server.ts");
const {
  getCommunityFeedDetail,
  resolveCommunityFeedDetailMediaSource,
} = await import("../../lib/feed/communityFeedDetail.server.ts");

function currentCycle(overrides = {}) {
  return {
    id: 72,
    public_number: 14,
    reset_count: 4,
    status: "voting_open",
    starts_at: "2026-08-12T08:00:00.000Z",
    ends_at: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

function finalizedCycle(publicNumber, id = publicNumber + 100, overrides = {}) {
  return {
    id,
    public_number: publicNumber,
    reset_count: 0,
    status: "finished",
    starts_at: "2026-08-01T08:00:00.000Z",
    ends_at: null,
    ended_at: "2026-08-03T20:00:00.000Z",
    finalized_at: "2026-08-03T20:01:00.000Z",
    internal_note: `private-cycle-${id}`,
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
    starts_at: "2026-08-09T08:00:00.000Z",
    ends_at: null,
    ended_at: "2026-08-11T20:00:00.000Z",
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
  state.userLogs = [];
  state.decodedLive = null;
  state.liveCursorError = null;
  state.decodedFinalized = null;
  state.decodedCatalog = null;
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
    cycleNumber: 14,
    resetCount: 4,
  });

  state.decodedLive = {
    context: { feed: "live", cycleNumber: 14, resetCount: 4 },
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

test("the finalized Cycle catalog is public-only, suitability-filtered, and bounded across pages", async () => {
  state.cycles = [
    ...Array.from({ length: 50 }, (_, index) =>
      finalizedCycle(100 - index, 500 - index, index === 0 ? { finalized_at: null } : {}),
    ),
    finalizedCycle(49, 449, { status: "draft" }),
    finalizedCycle(48, 448, { ended_at: null }),
  ];

  const first = await getCommunityFeedCycleCatalogPage();
  assert.equal(first.items.length, 48);
  assert.equal(first.hasMore, true);
  assert.equal(first.totalCount, 50);
  assert.equal(first.nextCursor, "catalog:53");
  assert.deepEqual(Object.keys(first.items[0]).sort(), [
    "cycleNumber",
    "endsAt",
    "startsAt",
  ]);
  assert.doesNotMatch(JSON.stringify(first), /internal|cycleId|cycle_id/u);

  state.decodedCatalog = { values: { cycleNumber: 53 } };
  const second = await getCommunityFeedCycleCatalogPage({ cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map((item) => item.cycleNumber),
    [52, 51],
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(second.totalCount, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.cycleNumber)).size,
    50,
  );
});

test("Top 10, All, and Trash apply one exact finalized Cycle before LIMIT", async () => {
  state.cycles = [finalizedCycle(13, 70), finalizedCycle(12, 69)];
  state.results = [
    finalizedResult(0, { cycle_id: 70, public_number: 13, rank_in_cycle: 10 }),
    finalizedResult(1, {
      cycle_id: 70,
      public_number: 13,
      rank_in_cycle: 10,
      submission_id: 2201,
    }),
    finalizedResult(2, {
      cycle_id: 70,
      public_number: 13,
      rank_in_cycle: 11,
      submission_id: 2202,
      feed_trash: true,
    }),
    finalizedResult(3, {
      cycle_id: 69,
      public_number: 12,
      rank_in_cycle: 1,
      submission_id: 2203,
    }),
  ];

  const [top10, all, trash] = await Promise.all([
    getCommunityFeedPage({ feed: "top10", cycleNumber: 13 }),
    getCommunityFeedPage({ feed: "all", cycleNumber: 13 }),
    getCommunityFeedPage({ feed: "trash", cycleNumber: 13 }),
  ]);
  assert.deepEqual(top10.items.map((item) => item.submissionId), [2000, 2201]);
  assert.deepEqual(all.items.map((item) => item.submissionId), [2000, 2201]);
  assert.deepEqual(trash.items.map((item) => item.submissionId), [2202]);
  for (const page of [top10, all, trash]) {
    assert.deepEqual(page.context, {
      kind: "finalized",
      classificationVersion: 1,
      cycleNumber: 13,
    });
    assert.equal(page.items.every((item) => item.cycleNumber === 13), true);
  }
  assert.ok(
    state.calls.some(
      (call) =>
        call[0] === "cycle_results" &&
        call[1] === "eq" &&
        call[2] === "cycle_id" &&
        call[3] === 70,
    ),
  );
});

test("unknown, non-finalized, and date-incomplete public Cycle filters stay exact and neutral", async () => {
  state.cycles = [
    finalizedCycle(11, 68, { status: "voting_open" }),
    finalizedCycle(12, 69, { ended_at: null }),
  ];
  state.results = [finalizedResult(0, { cycle_id: 70, public_number: 13 })];

  for (const cycleNumber of [11, 12, 999]) {
    const page = await getCommunityFeedPage({ feed: "all", cycleNumber });
    assert.deepEqual(page.items, []);
    assert.equal(page.context.cycleNumber, cycleNumber);
    assert.equal(page.cursorState, "start");
  }
});

test("legacy finished Cycles do not require the redundant Cycle finalized timestamp", async () => {
  state.cycles = [finalizedCycle(13, 70, { finalized_at: null })];
  state.results = [finalizedResult(0, { cycle_id: 70, public_number: 13 })];

  const page = await getCommunityFeedPage({ feed: "all", cycleNumber: 13 });

  assert.deepEqual(page.items.map((item) => item.submissionId), [2000]);
  assert.equal(page.context.cycleNumber, 13);
});

test("filtered anchors never resolve a Submission from another Cycle", async () => {
  state.cycles = [finalizedCycle(13, 70), finalizedCycle(12, 69)];
  state.results = [
    finalizedResult(0, {
      cycle_id: 69,
      public_number: 12,
      submission_id: 2300,
    }),
  ];
  const resolution = await resolveCommunityFeedAnchor({
    feed: "all",
    cycleNumber: 13,
    submissionId: 2300,
  });
  assert.equal(resolution.status, "unavailable");
  assert.equal(resolution.item, null);
  assert.equal(resolution.context.cycleNumber, 13);
});

test("a signed cursor from another selected Cycle fails closed", async () => {
  state.cycles = [finalizedCycle(13, 70)];
  state.decodedFinalized = {
    context: { feed: "all", classificationVersion: 1, cycleNumber: 12 },
    values: {
      finalizedAt: "2026-08-11T20:00:00.000Z",
      cycleNumber: 12,
      rankInCycle: 1,
      submissionId: 2400,
    },
  };
  await assert.rejects(
    getCommunityFeedPage({ feed: "all", cycleNumber: 13, cursor: "cycle-12" }),
    { name: "PublicPaginationCursorError" },
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
    "cycleNumber",
    "finalizedAt",
    "rankInCycle",
    "submissionId",
  ]);
  assert.equal(tuple.finalizedAt, "2026-08-11T20:00:00.730016+00:00");
  assert.equal(first.items[0].finalizedAt, "2026-08-11T20:00:00.730Z");

  state.decodedFinalized = {
    context: { feed: "all", classificationVersion: 1, cycleNumber: null },
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
    context: { feed: "all", classificationVersion: 1, cycleNumber: null },
    values: {
      finalizedAt: removed.finalized_at,
      cycleNumber: removed.voting_cycles.public_number,
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

test("filtered Feed media never crosses the selected public Cycle", async () => {
  state.cycles = [finalizedCycle(13, 70), finalizedCycle(12, 69)];
  const result = finalizedResult(0, {
    cycle_id: 69,
    public_number: 12,
    submission_id: 6150,
  });
  state.results = [result];
  assert.equal(
    await resolveCommunityFeedMediaSource({
      feed: "all",
      cycleNumber: 13,
      submissionId: 6150,
    }),
    null,
  );
  assert.deepEqual(
    await resolveCommunityFeedMediaSource({
      feed: "all",
      cycleNumber: 12,
      submissionId: 6150,
    }),
    { r2Key: result.submissions.r2_key },
  );
});

test("canonical detail returns the exact Live allowlist without final claims", async () => {
  const live = liveSubmission(0);
  state.submissions = [live];

  const detail = await getCommunityFeedDetail(live.id);
  const serialized = JSON.stringify(detail);

  assert.deepEqual(detail, {
    submissionId: live.id,
    state: "live",
    cycleNumber: 14,
    author: null,
    imageUrl: `/api/community-feed/detail/media/${live.id}`,
    mediaWidth: 1200,
    mediaHeight: 900,
    createdAt: live.created_at,
    cycleStartedAt: "2026-08-12T08:00:00.000Z",
    cycleEndedAt: "2026-08-14T08:00:00.000Z",
    finalizedAt: null,
    finalVoteCount: null,
    rankInCycle: null,
  });
  assert.doesNotMatch(serialized, /private-live|discord|moderation/iu);
  assert.equal(state.calls.some((call) => call[0] === "user_logs"), false);
});

test("canonical detail shows finalized metadata for both All and Trash eligibility", async () => {
  const all = finalizedResult(0, { submission_id: 6200 });
  const trash = finalizedResult(1, {
    submission_id: 6201,
    feed_trash: true,
  });
  state.results = [all, trash];
  state.userLogs = [all, trash].map((result, index) => ({
    public_profile_id: `00000000-0000-4000-8000-00000000000${index}`,
    discord_user_id: result.submissions.discord_user_id,
    current_guild_nickname: index === 0 ? "Server Creator" : null,
    current_display_name: "Global Creator",
    current_discord_handle: "creator.handle",
    current_discord_username: "LegacyCreator",
    avatar_key: index === 0 ? `avatars/${index}.webp` : null,
    avatar_updated_at: "2026-08-13T09:00:00.000Z",
    discord_avatar: null,
  }));

  for (const result of [all, trash]) {
    const detail = await getCommunityFeedDetail(result.submission_id);
    assert.equal(detail.state, "finalized");
    assert.equal(detail.submissionId, result.submission_id);
    assert.equal(detail.cycleNumber, 13);
    assert.equal(detail.finalVoteCount, result.final_vote_count);
    assert.equal(detail.rankInCycle, result.rank_in_cycle);
    const authorIndex = result === all ? 0 : 1;
    assert.equal(
      detail.author.publicProfileId,
      state.userLogs[authorIndex].public_profile_id,
    );
    assert.equal(
      detail.author.displayName,
      result === all ? "Server Creator" : "Global Creator",
    );
    if (result === all) {
      assert.match(
        detail.author.avatarUrl,
        new RegExp(
          `^/profile/${state.userLogs[0].public_profile_id}/avatar\\?v=[a-f0-9]{16}$`,
          "u",
        ),
      );
    } else {
      assert.equal(detail.author.avatarUrl, null);
    }
    assert.equal(detail.cycleStartedAt, "2026-08-09T08:00:00.000Z");
    assert.equal(detail.cycleEndedAt, "2026-08-11T20:00:00.000Z");
    assert.deepEqual(
      await resolveCommunityFeedDetailMediaSource(result.submission_id),
      { r2Key: result.submissions.r2_key },
    );
  }
  assert.ok(state.calls.some((call) => call[0] === "user_logs"));
});

test("finalized detail tolerates a missing public author without exposing the internal id", async () => {
  const result = finalizedResult(0, { submission_id: 6250 });
  state.results = [result];

  const detail = await getCommunityFeedDetail(result.submission_id);

  assert.equal(detail.author, null);
  assert.doesNotMatch(JSON.stringify(detail), /private-final|discord/iu);
});

test("canonical detail and media fail closed for removed, legal-review, DQ, and ineligible rows", async () => {
  state.results = [
    finalizedResult(0, {
      submission_id: 6300,
      submission: { public_visibility_status: "removed" },
    }),
    finalizedResult(1, {
      submission_id: 6301,
      submission: { public_visibility_status: "legal_review" },
    }),
    finalizedResult(2, {
      submission_id: 6302,
      submission: { is_disqualified: true },
    }),
    finalizedResult(3, {
      submission_id: 6303,
      feed_eligible: false,
    }),
  ];

  for (const submissionId of [6300, 6301, 6302, 6303, 6399]) {
    assert.equal(await getCommunityFeedDetail(submissionId), null);
    assert.equal(
      await resolveCommunityFeedDetailMediaSource(submissionId),
      null,
    );
  }
});

test("submission_closed remains part of the one current Live Cycle", async () => {
  state.cycles = [currentCycle({ status: "submission_closed" })];
  state.submissions = [liveSubmission(0)];

  const page = await getCommunityFeedPage({ feed: "live" });

  assert.deepEqual(
    page.items.map((item) => item.submissionId),
    [state.submissions[0].id],
  );
  assert.equal(page.context.cycleNumber, 14);
});

test("valid Live cursors reset clearly after a reset-count change", async () => {
  state.submissions = [liveSubmission(0)];
  state.decodedLive = {
    context: { feed: "live", cycleNumber: 14, resetCount: 3 },
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
    context: { feed: "live", cycleNumber: 14, resetCount: 4 },
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
  assert.equal(page.context.cycleNumber, 15);
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
    context: { feed: "live", cycleNumber: 14, resetCount: 4 },
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
