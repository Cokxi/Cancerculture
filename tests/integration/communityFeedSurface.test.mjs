import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  calls: [],
  resolution: null,
  pages: [],
};

mock.module(
  new URL("../../lib/feed/communityFeedReadModel.server.ts", import.meta.url),
  {
    namedExports: {
      async getCommunityFeedPage(input) {
        state.calls.push(["page", input]);
        return state.pages.shift();
      },
      async resolveCommunityFeedAnchor(input) {
        state.calls.push(["anchor", input]);
        return state.resolution;
      },
    },
  },
);

const { getCommunityFeedSurfacePage } = await import(
  "../../lib/feed/communityFeedSurface.server.ts"
);

function item(id) {
  return {
    submissionId: id,
    cycleNumber: 3,
    imageUrl: `https://images.example/${id}.webp`,
    mediaWidth: 800,
    mediaHeight: 600,
    createdAt: "2026-08-13T08:00:00.000Z",
    finalizedAt: "2026-08-13T09:00:00.000Z",
    finalVoteCount: 4,
    rankInCycle: id,
  };
}

function feedPage(overrides = {}) {
  return {
    items: [item(2), item(3)],
    nextCursor: "next.cursor",
    hasMore: true,
    feed: "all",
    context: { kind: "finalized", classificationVersion: 1 },
    cursorState: "continued",
    ...overrides,
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.resolution = null;
  state.pages = [];
});

test("ordinary and multi-page cursor requests pass only through Phase 2", async () => {
  state.pages.push(feedPage());
  const result = await getCommunityFeedSurfacePage({
    feed: "all",
    cursor: "page.two.cursor",
  });

  assert.equal(result.nextCursor, "next.cursor");
  assert.deepEqual(state.calls, [
    ["page", { feed: "all", cursor: "page.two.cursor" }],
  ]);
});

test("a deep Resume anchor is resolved directly and prepended to its continued page", async () => {
  state.resolution = {
    feed: "all",
    submissionId: 1,
    status: "resolved",
    context: { kind: "finalized", classificationVersion: 1 },
    item: item(1),
    resumeCursor: "anchor.cursor",
  };
  state.pages.push(feedPage());

  const result = await getCommunityFeedSurfacePage({
    feed: "all",
    anchorSubmissionId: 1,
  });

  assert.deepEqual(
    result.items.map((entry) => entry.submissionId),
    [1, 2, 3],
  );
  assert.deepEqual(state.calls, [
    ["anchor", { feed: "all", submissionId: 1 }],
    ["page", { feed: "all", cursor: "anchor.cursor" }],
  ]);
  assert.equal(state.calls.filter(([kind]) => kind === "page").length, 1);
});

test("removed or DQ anchors fall back to one bounded Feed-start read", async () => {
  state.resolution = {
    feed: "trash",
    submissionId: 44,
    status: "unavailable",
    context: { kind: "finalized", classificationVersion: 1 },
    item: null,
    resumeCursor: null,
  };
  state.pages.push(feedPage({ feed: "trash", cursorState: "start" }));

  const result = await getCommunityFeedSurfacePage({
    feed: "trash",
    anchorSubmissionId: 44,
  });
  assert.equal(result.cursorState, "anchor_unavailable_reset");
  assert.deepEqual(state.calls, [
    ["anchor", { feed: "trash", submissionId: 44 }],
    ["page", { feed: "trash" }],
  ]);
});

test("Cycle or reset changes never mix the stale resolved item into the new Live page", async () => {
  state.resolution = {
    feed: "live",
    submissionId: 70,
    status: "resolved",
    context: { kind: "live", cycleId: 5, cycleNumber: 4, resetCount: 1 },
    item: { ...item(70), finalizedAt: null, finalVoteCount: null, rankInCycle: null },
    resumeCursor: "old.live.cursor",
  };
  state.pages.push(
    feedPage({
      feed: "live",
      items: [{ ...item(99), finalizedAt: null, finalVoteCount: null, rankInCycle: null }],
      context: { kind: "live", cycleId: 5, cycleNumber: 4, resetCount: 2 },
      cursorState: "context_unavailable_reset",
    }),
  );

  const result = await getCommunityFeedSurfacePage({
    feed: "live",
    anchorSubmissionId: 70,
  });
  assert.deepEqual(result.items.map((entry) => entry.submissionId), [99]);
  assert.equal(result.cursorState, "context_unavailable_reset");
});

test("cursor and direct anchor cannot be combined", async () => {
  await assert.rejects(
    getCommunityFeedSurfacePage({
      feed: "all",
      cursor: "cursor",
      anchorSubmissionId: 1,
    }),
    /COMMUNITY_FEED_SURFACE_INPUT_INVALID/u,
  );
  assert.deepEqual(state.calls, []);
});
