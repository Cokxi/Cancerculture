import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];

mock.module(
  new URL("../../lib/feed/communityFeedReadModel.server.ts", import.meta.url),
  {
    namedExports: {
      async getCommunityFeedCycleCatalogPage(input) {
        calls.push(input);
        if (input.cursor === "invalid") throw new Error("INVALID_CURSOR");
        return { items: [], nextCursor: null, hasMore: false, totalCount: 0 };
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

const { GET } = await import(
  "../../app/api/community-feed/cycles/route.ts"
);

test.beforeEach(() => {
  calls.length = 0;
});

test("the Cycle catalog route forwards one signed cursor and is always no-store", async () => {
  const response = await GET(
    new Request(
      "https://cancerculture.example/api/community-feed/cycles?cursor=signed.catalog",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [{ cursor: "signed.catalog" }]);
  assert.deepEqual(await response.json(), {
    items: [],
    nextCursor: null,
    hasMore: false,
    totalCount: 0,
  });
});

test("an invalid catalog cursor fails closed through the public pagination error", async () => {
  const response = await GET(
    new Request(
      "https://cancerculture.example/api/community-feed/cycles?cursor=invalid",
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
