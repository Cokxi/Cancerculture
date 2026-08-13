import assert from "node:assert/strict";
import test from "node:test";
import {
  getCommunityFeedHref,
  isCommunityFeedPage,
  mergeCommunityFeedItems,
} from "../../lib/feed/communityFeedSurface.ts";

function item(id = 10) {
  return {
    submissionId: id,
    cycleNumber: 4,
    imageUrl: `https://images.example/${id}.webp`,
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
    context: { kind: "finalized", classificationVersion: 1 },
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
            ...item(),
            finalizedAt: null,
            finalVoteCount: null,
            rankInCycle: null,
          },
        ],
        context: {
          kind: "live",
          cycleId: 9,
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
    page({ items: [{ ...item(), mediaHeight: null }] }),
    page({ feed: "live" }),
    page({ items: [{ ...item(), finalizedAt: null }] }),
    page({ context: { kind: "finalized", classificationVersion: 1, actor: 2 } }),
    page({ cursorState: "unknown" }),
  ]) {
    assert.equal(isCommunityFeedPage(invalid), false);
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
});
