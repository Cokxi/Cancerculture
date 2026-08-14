import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS,
  COMMUNITY_FEED_VIEWPORT_DWELL_MS,
  COMMUNITY_FEED_VIEWPORT_THRESHOLD,
  createCommunityFeedResumeRecord,
  getCommunityFeedResumeStorageKey,
  isCommunityFeedResumeCurrent,
  parseCommunityFeedResumeRecord,
} from "../../lib/feed/communityFeedResume.ts";

const liveContext = {
  kind: "live",
  cycleNumber: 17,
  resetCount: 3,
};
const finalizedContext = {
  kind: "finalized",
  classificationVersion: 1,
  cycleNumber: null,
};

test("All-Cycles and every selected Cycle have separate browser-local progress keys", () => {
  const keys = [
    getCommunityFeedResumeStorageKey("live"),
    getCommunityFeedResumeStorageKey("top10"),
    getCommunityFeedResumeStorageKey("all"),
    getCommunityFeedResumeStorageKey("all", 12),
    getCommunityFeedResumeStorageKey("all", 13),
    getCommunityFeedResumeStorageKey("trash", 12),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [
    "cancerculture.community-feed.resume.v2.live",
    "cancerculture.community-feed.resume.v2.top10.cycle-all",
    "cancerculture.community-feed.resume.v2.all.cycle-all",
    "cancerculture.community-feed.resume.v2.all.cycle-12",
    "cancerculture.community-feed.resume.v2.all.cycle-13",
    "cancerculture.community-feed.resume.v2.trash.cycle-12",
  ]);
});

test("Live progress is semantic and binds Cycle plus reset context", () => {
  const record = createCommunityFeedResumeRecord({
    feed: "live",
    submissionId: 912,
    context: liveContext,
    viewedAt: "2026-08-13T09:10:11.000Z",
  });

  assert.deepEqual(record, {
    version: 2,
    feed: "live",
    submissionId: 912,
    viewedAt: "2026-08-13T09:10:11.000Z",
    context: { kind: "live", cycleNumber: 17, resetCount: 3 },
  });
  assert.equal(
    isCommunityFeedResumeCurrent(record, "live", liveContext),
    true,
  );
  assert.equal(
    isCommunityFeedResumeCurrent(record, "live", {
      ...liveContext,
      cycleNumber: 18,
    }),
    false,
  );
  assert.equal(
    isCommunityFeedResumeCurrent(record, "live", {
      ...liveContext,
      resetCount: 4,
    }),
    false,
  );
});

test("finalized Feed progress is separate by Feed and classification version", () => {
  const record = createCommunityFeedResumeRecord({
    feed: "all",
    submissionId: 501,
    context: finalizedContext,
    viewedAt: "2026-08-13T09:10:11.000Z",
  });

  assert.equal(
    isCommunityFeedResumeCurrent(record, "all", finalizedContext),
    true,
  );
  assert.equal(
    isCommunityFeedResumeCurrent(record, "top10", finalizedContext),
    false,
  );
  assert.equal(
    isCommunityFeedResumeCurrent(record, "all", {
      kind: "finalized",
      classificationVersion: 2,
      cycleNumber: null,
    }),
    false,
  );
  assert.throws(
    () =>
      createCommunityFeedResumeRecord({
        feed: "trash",
        submissionId: 501,
        context: liveContext,
      }),
    /COMMUNITY_FEED_RESUME_CONTEXT_INVALID/u,
  );
});

test("finalized Resume never crosses between All-Cycles and selected Cycles", () => {
  const selected = { ...finalizedContext, cycleNumber: 12 };
  const record = createCommunityFeedResumeRecord({
    feed: "all",
    submissionId: 700,
    context: selected,
  });
  assert.equal(isCommunityFeedResumeCurrent(record, "all", selected), true);
  assert.equal(
    isCommunityFeedResumeCurrent(record, "all", finalizedContext),
    false,
  );
  assert.equal(
    isCommunityFeedResumeCurrent(record, "all", {
      ...selected,
      cycleNumber: 13,
    }),
    false,
  );
  assert.doesNotMatch(JSON.stringify(record), /cycleId|cycle_id/u);
});

test("stored progress parser rejects malformed, stale-shape, and privacy-expanded values", () => {
  const valid = createCommunityFeedResumeRecord({
    feed: "top10",
    submissionId: 77,
    context: finalizedContext,
    viewedAt: "2026-08-13T09:10:11.000Z",
  });
  assert.deepEqual(
    parseCommunityFeedResumeRecord(JSON.stringify(valid)),
    valid,
  );

  for (const value of [
    "not-json",
    JSON.stringify({ ...valid, pixelOffset: 1200 }),
    JSON.stringify({ ...valid, discordId: "private" }),
    JSON.stringify({ ...valid, submissionId: -1 }),
    JSON.stringify({ ...valid, viewedAt: "yesterday" }),
    JSON.stringify({ ...valid, context: { ...valid.context, resetCount: 2 } }),
  ]) {
    assert.equal(parseCommunityFeedResumeRecord(value), null);
  }
});

test("meaningful viewport progress is dwell-based and debounced within bounded constants", () => {
  assert.ok(COMMUNITY_FEED_VIEWPORT_THRESHOLD >= 0.5);
  assert.ok(COMMUNITY_FEED_VIEWPORT_THRESHOLD <= 0.8);
  assert.ok(COMMUNITY_FEED_VIEWPORT_DWELL_MS >= 500);
  assert.ok(COMMUNITY_FEED_VIEWPORT_DWELL_MS <= 2_000);
  assert.ok(COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS >= 250);
  assert.ok(COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS <= 1_000);
});
