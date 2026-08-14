import assert from "node:assert/strict";
import test from "node:test";
import {
  createNeutralCommunityFeedMediaResponse,
  proxyCommunityFeedMedia,
} from "../../lib/feed/communityFeedMedia.ts";

test("Feed media uses only the configured HTTPS origin and returns bounded WebP bytes", async () => {
  let capturedUrl = null;
  let capturedInit = null;
  const response = await proxyCommunityFeedMedia({
    storageKey: "submissions/cycle image.webp",
    configuredBase: "https://media.example.test/assets/",
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Length": "3",
          "Content-Type": "image/webp",
        },
      });
    },
  });

  assert.equal(
    capturedUrl.href,
    "https://media.example.test/assets/submissions/cycle%20image.webp",
  );
  assert.equal(capturedInit.redirect, "error");
  assert.equal(capturedInit.cache, "no-store");
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

for (const configuredBase of [
  "http://media.example.test",
  "https://user:password@media.example.test",
  "https://media.example.test?origin=other",
]) {
  test(`Feed media rejects unsafe configured origin ${configuredBase}`, async () => {
    let called = false;
    const response = await proxyCommunityFeedMedia({
      storageKey: "submissions/1.webp",
      configuredBase,
      fetchImpl: async () => {
        called = true;
        throw new Error("must not fetch");
      },
    });

    assert.equal(called, false);
    assert.equal(response.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  });
}

test("Feed media rejects redirects, non-WebP content, declared oversize, streamed oversize, and timeouts neutrally", async () => {
  const cases = [
    async () => Response.redirect("https://other.example/file.webp", 302),
    async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }),
    async () => new Response(new Uint8Array([1]), {
      headers: { "Content-Type": "image/webp", "Content-Length": "4000001" },
    }),
    async () => new Response(new Uint8Array(4_000_001), {
      headers: { "Content-Type": "image/webp" },
    }),
    async () => { throw new DOMException("timed out", "TimeoutError"); },
  ];

  for (const fetchImpl of cases) {
    const response = await proxyCommunityFeedMedia({
      storageKey: "submissions/1.webp",
      configuredBase: "https://media.example.test",
      fetchImpl,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.match(response.headers.get("cache-control"), /no-store/u);
  }
});

test("neutral Feed media responses contain no storage key or moderation state", async () => {
  const response = createNeutralCommunityFeedMediaResponse();
  const body = await response.text();
  assert.doesNotMatch(body, /r2|hidden|disqual|legal|submission/u);
});
