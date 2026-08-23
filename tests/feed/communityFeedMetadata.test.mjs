import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCommunityFeedMetadata } from "../../lib/feed/communityFeedMetadata.ts";

const root = new URL("../../", import.meta.url);
const [page, readModel] = await Promise.all([
  readFile(new URL("app/spread/[submissionId]/page.tsx", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedDetail.server.ts", root), "utf8"),
]);

test("public meme metadata has exact canonical and Open Graph image URLs", () => {
  const metadata = createCommunityFeedMetadata({
    submissionId: 17,
    mediaWidth: 1200,
    mediaHeight: 900,
  });

  assert.equal(metadata.title, "Meme on CancerCulture");
  assert.equal(metadata.description, "View this public meme in The Spread on CancerCulture.");
  assert.equal(metadata.alternates.canonical, "https://cancerculture.fun/spread/17");
  assert.equal(metadata.openGraph.url, "https://cancerculture.fun/spread/17");
  assert.deepEqual(metadata.openGraph.images, [{
    url: "https://cancerculture.fun/api/community-feed/detail/media/17",
    alt: "Community meme on CancerCulture",
    type: "image/webp",
    width: 1200,
    height: 900,
  }]);
});

test("invalid, removed, disqualified, legally held, or media-less sources receive no specific metadata", () => {
  const metadata = createCommunityFeedMetadata(null);
  assert.equal(metadata.title, "CancerCulture");
  assert.equal(metadata.description, "CancerCulture");
  assert.equal(metadata.alternates, undefined);
  assert.equal(metadata.openGraph, undefined);
  assert.equal(metadata.twitter, undefined);
  assert.deepEqual(metadata.robots, { index: false, follow: false });

  assert.match(page, /generateMetadata/u);
  assert.match(page, /if \(!submissionId\) return createCommunityFeedMetadata\(null\)/u);
  assert.match(page, /catch \{[\s\S]*return createCommunityFeedMetadata\(null\)/u);
  assert.match(readModel, /public_visibility_status", "visible"/u);
  assert.match(readModel, /is_disqualified\.is\.null,is_disqualified\.eq\.false/u);
  assert.match(readModel, /getCommunityFeedDetailMetadataSource/u);
  assert.match(readModel, /if \(!source\?\.r2Key \|\| !source\.detail\.imageUrl\) return null/u);
});

test("metadata contains no private identity, payout, or moderation fields", () => {
  const serialized = JSON.stringify(createCommunityFeedMetadata({
    submissionId: 29,
    mediaWidth: null,
    mediaHeight: null,
  }));
  assert.doesNotMatch(
    serialized,
    /discord|wallet|payout|moderation|report|legal|disqual|r2_key|public_profile/iu,
  );
});
