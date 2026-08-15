import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCommunityFeedCycleDateRange,
  getCommunityFeedHref,
  groupCommunityFeedCyclesByNumberRange,
  isCommunityFeedCycleCatalogPage,
  isCommunityFeedPage,
  mergeCommunityFeedCycleCatalogItems,
  mergeCommunityFeedItems,
} from "../../lib/feed/communityFeedSurface.ts";

function item(id = 10, feed = "all", cycleNumber = null) {
  return {
    submissionId: id,
    cycleNumber: 4,
    imageUrl: `/api/community-feed/media/${id}?feed=${feed}${cycleNumber ? `&cycle=${cycleNumber}` : ""}`,
    mediaWidth: 1200,
    mediaHeight: 900,
    createdAt: "2026-08-13T08:00:00.000Z",
    finalizedAt: "2026-08-13T09:00:00.000Z",
    finalVoteCount: 6,
    rankInCycle: 2,
  };
}

function page(overrides = {}) {
  return {
    items: [item()],
    nextCursor: "signed.cursor",
    hasMore: true,
    feed: "all",
    context: { kind: "finalized", classificationVersion: 1, cycleNumber: null },
    cursorState: "continued",
    ...overrides,
  };
}

test("the browser accepts only the exact allowlisted Feed page and DTO", () => {
  assert.equal(isCommunityFeedPage(page()), true);
  assert.equal(
    isCommunityFeedPage(
      page({
        feed: "live",
        items: [
          {
            ...item(10, "live"),
            finalizedAt: null,
            finalVoteCount: null,
            rankInCycle: null,
          },
        ],
        context: {
          kind: "live",
          cycleNumber: 8,
          resetCount: 2,
        },
      }),
    ),
    true,
  );

  for (const invalid of [
    page({ discordId: "leak" }),
    page({ items: [{ ...item(), moderationReason: "private" }] }),
    page({ items: [{ ...item(), cycleId: 9 }] }),
    page({ items: [{ ...item(), imageUrl: "http://unsafe.example/a" }] }),
    page({ items: [{ ...item(), imageUrl: "https://images.example/a.webp" }] }),
    page({ items: [{ ...item(), imageUrl: "/api/community-feed/media/10?feed=live" }] }),
    page({ items: [{ ...item(), mediaHeight: null }] }),
    page({ feed: "live" }),
    page({ items: [{ ...item(), finalizedAt: null }] }),
    page({ context: { kind: "finalized", classificationVersion: 1, cycleNumber: null, actor: 2 } }),
    page({ cursorState: "unknown" }),
  ]) {
    assert.equal(isCommunityFeedPage(invalid), false);
  }
});

test("the browser accepts only the exact public finalized Cycle catalog DTO", () => {
  const page = {
    items: [
      {
        cycleNumber: 42,
        startsAt: "2026-08-01T08:00:00.000Z",
        endsAt: "2026-08-03T20:00:00.000Z",
      },
    ],
    nextCursor: "signed.catalog.cursor",
    hasMore: true,
    totalCount: 100,
  };
  assert.equal(isCommunityFeedCycleCatalogPage(page), true);
  for (const invalid of [
    { ...page, items: [{ ...page.items[0], cycleId: 70 }] },
    { ...page, items: [{ ...page.items[0], sponsorName: "private" }] },
    { ...page, items: [{ ...page.items[0], cycleNumber: 0 }] },
    { ...page, items: [{ ...page.items[0], startsAt: "yesterday" }] },
    { ...page, totalCount: -1 },
    { ...page, totalCount: 100.5 },
    { ...page, totalCount: 0 },
  ]) {
    assert.equal(isCommunityFeedCycleCatalogPage(invalid), false);
  }
});

test("multi-page merge preserves deterministic order and removes overlap", () => {
  assert.deepEqual(
    mergeCommunityFeedItems([item(1), item(2)], [item(2), item(3), item(3)]).map(
      (entry) => entry.submissionId,
    ),
    [1, 2, 3],
  );
});

test("Cycle catalog pages deduplicate deterministically and group into ten-Cycle ranges", () => {
  const first = [
    {
      cycleNumber: 102,
      startsAt: "2026-12-28T08:00:00.000Z",
      endsAt: "2027-01-03T20:00:00.000Z",
    },
    {
      cycleNumber: 101,
      startsAt: "2026-08-08T08:00:00.000Z",
      endsAt: "2026-08-14T20:00:00.000Z",
    },
  ];
  const merged = mergeCommunityFeedCycleCatalogItems(first, [
    first[1],
    {
      cycleNumber: 100,
      startsAt: "2025-12-20T08:00:00.000Z",
      endsAt: "2025-12-27T20:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    merged.map((item) => item.cycleNumber),
    [102, 101, 100],
  );
  assert.deepEqual(
    groupCommunityFeedCyclesByNumberRange(merged).map((group) => ({
      rangeStart: group.rangeStart,
      rangeEnd: group.rangeEnd,
      cycles: group.cycles.map((item) => item.cycleNumber),
    })),
    [
      { rangeStart: 101, rangeEnd: 110, cycles: [102, 101] },
      { rangeStart: 91, rangeEnd: 100, cycles: [100] },
    ],
  );
  assert.equal(
    formatCommunityFeedCycleDateRange(first[1]),
    "08–14 Aug 2026",
  );
  assert.equal(
    formatCommunityFeedCycleDateRange(first[0]),
    "28 Dec 2026–03 Jan 2027",
  );
});

test("synthetic three-page smoke stays bounded and deduplicates cursor overlap", () => {
  const first = Array.from({ length: 48 }, (_, index) => item(index + 1));
  const second = Array.from({ length: 49 }, (_, index) => item(index + 48));
  const third = Array.from({ length: 18 }, (_, index) => item(index + 96));
  const merged = mergeCommunityFeedItems(
    mergeCommunityFeedItems(first, second),
    third,
  );

  assert.equal(merged.length, 113);
  assert.deepEqual(
    merged.map((entry) => entry.submissionId),
    Array.from({ length: 113 }, (_, index) => index + 1),
  );
});

test("Feed deep links retain exact Feed scope and semantic Submission anchor", () => {
  assert.equal(getCommunityFeedHref("live"), "/spread?feed=live");
  assert.equal(
    getCommunityFeedHref("trash", 901),
    "/spread?feed=trash&submission=901",
  );
  assert.equal(
    getCommunityFeedHref("trash", 901, 42),
    "/spread?feed=trash&cycle=42&submission=901",
  );
});

test("filtered Feed DTO validation binds media and context to the exact public Cycle", () => {
  const filtered = page({
    items: [item(10, "all", 42)],
    context: { kind: "finalized", classificationVersion: 1, cycleNumber: 42 },
  });
  assert.equal(isCommunityFeedPage(filtered), true);
  assert.equal(
    isCommunityFeedPage({
      ...filtered,
      items: [item(10, "all", 41)],
    }),
    false,
  );
  assert.doesNotMatch(JSON.stringify(filtered), /cycleId|cycle_id/u);
});
