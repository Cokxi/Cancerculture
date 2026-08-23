import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMMUNITY_FEED_SHARE_TEXT,
  COMMUNITY_FEED_SHARE_TITLE,
  getCommunityFeedBaseShareData,
  shareCommunityFeedMeme,
} from "../../lib/feed/communityFeedShare.ts";

const root = new URL("../../", import.meta.url);
const actions = await readFile(
  new URL("app/spread/CommunityFeedCardActions.tsx", root),
  "utf8",
);

function fakeFileFactory(fileBits, fileName, options) {
  return {
    fileBits,
    name: fileName,
    type: options.type,
  };
}

function publicImageResponse() {
  return new Response(
    new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    { headers: { "Content-Type": "image/webp" } },
  );
}

test("native Share includes the safe public image file, neutral text, and canonical link when supported", async () => {
  let fetched = null;
  let fetchInit = null;
  let canShareData = null;
  let sharedData = null;
  const outcome = await shareCommunityFeedMeme({
    submissionId: 17,
    navigatorImpl: {
      canShare(data) {
        canShareData = data;
        return Array.isArray(data.files) && data.files.length === 1;
      },
      async share(data) {
        sharedData = data;
      },
    },
    async fetchImpl(input, init) {
      fetched = input;
      fetchInit = init;
      return publicImageResponse();
    },
    fileFactory: fakeFileFactory,
  });

  assert.equal(outcome, "shared");
  assert.equal(fetched, "/api/community-feed/detail/media/17");
  assert.equal(fetchInit.cache, "no-store");
  assert.equal(fetchInit.redirect, "error");
  assert.equal(fetchInit.credentials, "same-origin");
  assert.equal(canShareData.files[0].name, "cancerculture-meme.webp");
  assert.deepEqual(sharedData, canShareData);
  assert.equal(sharedData.title, COMMUNITY_FEED_SHARE_TITLE);
  assert.equal(sharedData.text, COMMUNITY_FEED_SHARE_TEXT);
  assert.equal(sharedData.url, "https://cancerculture.fun/spread/17");
});

test("Share falls back to only neutral text and the canonical link without File Sharing", async () => {
  let fetchCalled = false;
  let sharedData = null;
  const outcome = await shareCommunityFeedMeme({
    submissionId: 23,
    navigatorImpl: {
      async share(data) {
        sharedData = data;
      },
    },
    async fetchImpl() {
      fetchCalled = true;
      throw new Error("must not load an image without File Share support");
    },
    fileFactory: fakeFileFactory,
  });

  assert.equal(outcome, "shared");
  assert.equal(fetchCalled, false);
  assert.deepEqual(sharedData, getCommunityFeedBaseShareData(23));
  assert.equal("files" in sharedData, false);
});

test("unsafe or unavailable image responses fall back to text and link", async () => {
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    new Response(new Uint8Array(), { headers: { "Content-Type": "image/webp" } }),
  ]) {
    let sharedData = null;
    const outcome = await shareCommunityFeedMeme({
      submissionId: 31,
      navigatorImpl: {
        canShare: () => true,
        async share(data) {
          sharedData = data;
        },
      },
      fetchImpl: async () => response.clone(),
      fileFactory: fakeFileFactory,
    });
    assert.equal(outcome, "shared");
    assert.deepEqual(sharedData, getCommunityFeedBaseShareData(31));
  }
});

test("user cancellation, technical failure, and missing native support remain distinct", async () => {
  const abort = new Error("cancelled");
  abort.name = "AbortError";
  assert.equal(
    await shareCommunityFeedMeme({
      submissionId: 41,
      navigatorImpl: { share: async () => { throw abort; } },
    }),
    "aborted",
  );
  assert.equal(
    await shareCommunityFeedMeme({
      submissionId: 41,
      navigatorImpl: { share: async () => { throw new Error("broken"); } },
    }),
    "failed",
  );
  assert.equal(
    await shareCommunityFeedMeme({ submissionId: 41, navigatorImpl: {} }),
    "unsupported",
  );
});

test("the visible Copy Link fallback and synchronous busy guard do not alter Save", () => {
  assert.match(actions, />\s*Copy Link\s*</u);
  assert.match(actions, /copyToClipboard\(canonicalUrl\(\)\)/u);
  assert.match(actions, /if \(shareBusyRef\.current\) return/u);
  assert.match(actions, /shareBusyRef\.current = true/u);
  assert.match(actions, /shareBusyRef\.current = false/u);
  assert.match(actions, /method: saved \? "DELETE" : "PUT"/u);
});

test("Share payload contains no private or moderation fields", () => {
  const serialized = JSON.stringify(getCommunityFeedBaseShareData(17));
  assert.doesNotMatch(
    serialized,
    /discord|wallet|moderation|report|legal|disqual|r2_key|public_profile/iu,
  );
});
