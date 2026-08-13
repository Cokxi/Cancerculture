import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { calls: [] };
const responsePage = {
  items: [],
  nextCursor: null,
  hasMore: false,
  feed: "live",
  context: null,
  cursorState: "start",
};

mock.module(
  new URL("../../lib/feed/communityFeedSurface.server.ts", import.meta.url),
  {
    namedExports: {
      async getCommunityFeedSurfacePage(input) {
        state.calls.push(input);
        return { ...responsePage, feed: input.feed };
      },
    },
  },
);

mock.module(
  new URL(
    "../../lib/pagination/getPublicPaginationErrorResponse.ts",
    import.meta.url,
  ),
  {
    namedExports: {
      getPublicPaginationErrorResponse() {
        return Response.json(
          { error: "INVALID_CURSOR" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
);

const { GET } = await import("../../app/api/community-feed/route.ts");

test.beforeEach(() => {
  state.calls = [];
});

test("GET exposes bounded Feed cursor pages with no-store", async () => {
  const response = await GET(
    new Request(
      "https://cancerculture.example/api/community-feed?feed=top10&cursor=signed.cursor",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(state.calls, [
    {
      feed: "top10",
      cursor: "signed.cursor",
      anchorSubmissionId: null,
    },
  ]);
  assert.equal((await response.json()).feed, "top10");
});

test("GET forwards one exact semantic anchor without page walking", async () => {
  const response = await GET(
    new Request(
      "https://cancerculture.example/api/community-feed?feed=trash&anchor=712",
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls, [
    { feed: "trash", cursor: null, anchorSubmissionId: 712 },
  ]);
});

test("invalid Feed, anchor, and ambiguous positioning fail before the read model", async () => {
  for (const query of [
    "feed=unknown",
    "feed=all&anchor=0",
    "feed=all&anchor=abc",
    "feed=all&anchor=2&cursor=signed.cursor",
  ]) {
    const response = await GET(
      new Request(
        `https://cancerculture.example/api/community-feed?${query}`,
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(state.calls, []);
});
