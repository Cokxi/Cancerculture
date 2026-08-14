import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [readModel, feedTypes, cursor, pagination] = await Promise.all([
  readFile(
    new URL("lib/feed/communityFeedReadModel.server.ts", root),
    "utf8",
  ),
  readFile(new URL("lib/feed/communityFeed.ts", root), "utf8"),
  readFile(
    new URL("lib/feed/communityFeedCursor.server.ts", root),
    "utf8",
  ),
  readFile(
    new URL("lib/pagination/publicPagination.ts", root),
    "utf8",
  ),
]);

test("the Feed read model is service-only and performs no transition or mutation", () => {
  assert.match(readModel, /^import "server-only";/u);
  assert.match(readModel, /supabaseAdmin/u);
  assert.doesNotMatch(
    readModel,
    /processDueCycleTransitions|phaseAutomation|phaseTransitions/u,
  );
  assert.doesNotMatch(
    readModel,
    /\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/u,
  );
  assert.doesNotMatch(readModel, /feed_items|capabilit(?:y|ies)/iu);
});

test("current visibility and DQ filters are in the bounded database query before LIMIT", () => {
  const finalizedQuery = readModel.match(
    /function finalizedFeedQuery[\s\S]*?return query;\n\}/u,
  )?.[0] ?? "";
  const livePageQuery = readModel.match(
    /let query = supabaseAdmin\n    \.from\("submissions"\)[\s\S]*?const \{ data, error \} = await query\.limit/u,
  )?.[0] ?? "";

  for (const query of [finalizedQuery, livePageQuery]) {
    assert.match(query, /public_visibility_status", "visible"/u);
    assert.match(query, /is_disqualified\.is\.null,is_disqualified\.eq\.false/u);
  }
  assert.ok(
    readModel.indexOf('.eq("submissions.public_visibility_status", "visible")') <
      readModel.indexOf("function getFinalizedAnchorRow"),
  );
  assert.doesNotMatch(readModel, /\.range\(|offset/iu);
  assert.match(readModel, /PUBLIC_SUBMISSION_PAGE_SIZE \+ 1/u);
});

test("all four Feed predicates and both deterministic orderings are explicit", () => {
  assert.match(readModel, /"submission_closed"/u);
  assert.match(readModel, /\.eq\("feed_eligible", true\)/u);
  assert.match(readModel, /\.gt\("final_vote_count", 0\)/u);
  assert.match(readModel, /\.lte\("rank_in_cycle", 10\)/u);
  assert.match(readModel, /query = query\.eq\("feed_trash", feed === "trash"\)/u);
  assert.match(
    readModel,
    /\.order\("created_at", \{ ascending: false \}\)\n    \.order\("id", \{ ascending: false \}\)/u,
  );
  assert.match(
    readModel,
    /\.order\("finalized_at", \{ ascending: false \}\)\n    \.order\("cycle_id", \{ ascending: false \}\)\n    \.order\("rank_in_cycle", \{ ascending: true \}\)\n    \.order\("submission_id", \{ ascending: true \}\)/u,
  );
});

test("Feed cursors extend the existing signed mechanism with exact scopes and contexts", () => {
  for (const scope of [
    "feedLive",
    "feedTop10",
    "feedAll",
    "feedTrash",
    "feedCycleCatalog",
  ]) {
    assert.match(pagination, new RegExp(`${scope}: "feed-`, "u"));
  }
  assert.match(cursor, /encodeServerPublicPaginationCursor/u);
  assert.match(cursor, /decodeServerPublicPaginationCursor/u);
  assert.match(cursor, /decodeServerPublicPaginationCursorForScope/u);
  assert.match(cursor, /classificationVersion/u);
  assert.match(cursor, /cycleNumber, resetCount/u);
  assert.match(cursor, /catalog: "finalized-cycles"/u);
  assert.doesNotMatch(cursor, /cycleId/u);
  assert.doesNotMatch(cursor, /createHmac|PUBLIC_PAGINATION_CURSOR_SECRET/u);
});

test("the finalized Cycle catalog is service-only, public-only, and bounded", () => {
  const catalog = readModel.match(
    /export async function getCommunityFeedCycleCatalogPage[\s\S]*?async function getLiveAnchorRow/u,
  )?.[0] ?? "";
  assert.match(catalog, /\.from\("voting_cycles"\)/u);
  assert.match(catalog, /\.eq\("status", "finished"\)/u);
  assert.match(catalog, /\.order\("public_number", \{ ascending: false \}\)/u);
  assert.match(catalog, /COMMUNITY_FEED_CYCLE_CATALOG_PAGE_SIZE \+ 1/u);
  assert.match(catalog, /cycleNumber:/u);
  assert.match(catalog, /startsAt:/u);
  assert.match(catalog, /endsAt:/u);
  assert.doesNotMatch(catalog, /sponsor|discord|moderation|report|observation/iu);
});

test("the exact public Cycle filter resolves server-side before the bounded result query", () => {
  assert.match(readModel, /getFinalizedCycleFilter/u);
  assert.match(readModel, /\.eq\("public_number", requireCycleNumber\(cycleNumber\)\)/u);
  assert.match(readModel, /query = query\.eq\("cycle_id", cycleId\)/u);
  assert.ok(
    readModel.indexOf('query = query.eq("cycle_id", cycleId)') <
      readModel.indexOf("PUBLIC_SUBMISSION_PAGE_SIZE + 1"),
  );
});

test("anchor and cursor validation use direct exact-ID lookups without sequential page search", () => {
  assert.match(
    readModel,
    /getLiveAnchorRow[\s\S]*?\.eq\("id", requireSubmissionId\(submissionId\)\)/u,
  );
  assert.match(
    readModel,
    /getFinalizedAnchorRow[\s\S]*?\.eq\("submission_id", requireSubmissionId\(submissionId\)\)/u,
  );
  assert.match(readModel, /anchor_unavailable_reset/u);
  assert.match(readModel, /LIVE_CONTEXT_RETRY_LIMIT/u);
  assert.match(readModel, /liveCyclesMatch/u);
  assert.doesNotMatch(readModel, /while\s*\(|loadUntil|nextCursor.*anchor/iu);
});

test("the public DTO is an explicit privacy allowlist", () => {
  const itemType = feedTypes.match(
    /export type CommunityFeedItem = \{[\s\S]*?\n\};/u,
  )?.[0] ?? "";
  const finalizedSelect = readModel.match(
    /const FINALIZED_FEED_SELECT = `[\s\S]*?`;/u,
  )?.[0] ?? "";

  for (const key of [
    "submissionId",
    "cycleNumber",
    "imageUrl",
    "mediaWidth",
    "mediaHeight",
    "createdAt",
    "finalizedAt",
    "finalVoteCount",
    "rankInCycle",
  ]) {
    assert.match(itemType, new RegExp(`${key}:`, "u"));
  }
  assert.doesNotMatch(
    `${itemType}\n${finalizedSelect}`,
    /discord|moderation|observation|report|sponsor|wallet|private|reason|actor|viewer|comment/iu,
  );
  assert.doesNotMatch(itemType, /cycleId:/u);
  assert.match(itemType, /cycleNumber:/u);
  assert.doesNotMatch(readModel, /getPublicImageUrl|R2_PUBLIC_BASE_URL/u);
  assert.match(readModel, /getCommunityFeedMediaPath/u);
});
