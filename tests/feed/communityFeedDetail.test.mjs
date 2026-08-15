import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMMUNITY_FEED_DETAIL_KEYS,
  getCommunityFeedDetailHref,
  getCommunityFeedDetailMediaPath,
  isCommunityFeedDetail,
} from "../../lib/feed/communityFeedDetail.ts";

const root = new URL("../../", import.meta.url);
const [page, notFound, readModel, mediaRoute, client, closeButton] = await Promise.all([
  readFile(new URL("app/spread/[submissionId]/page.tsx", root), "utf8"),
  readFile(new URL("app/spread/[submissionId]/not-found.tsx", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedDetail.server.ts", root), "utf8"),
  readFile(
    new URL("app/api/community-feed/detail/media/[submissionId]/route.ts", root),
    "utf8",
  ),
  readFile(new URL("app/spread/CommunityFeedClient.tsx", root), "utf8"),
  readFile(
    new URL(
      "app/spread/[submissionId]/CommunityFeedDetailCloseButton.tsx",
      root,
    ),
    "utf8",
  ),
]);

function detail(overrides = {}) {
  return {
    submissionId: 17,
    state: "finalized",
    cycleNumber: 8,
    author: {
      publicProfileId: "3c302413-f713-4aee-bf6c-d7152f1800f1",
      displayName: "Current Creator",
      avatarUrl:
        "/profile/3c302413-f713-4aee-bf6c-d7152f1800f1/avatar?v=0123456789abcdef",
    },
    imageUrl: "/api/community-feed/detail/media/17",
    mediaWidth: 1200,
    mediaHeight: 900,
    createdAt: "2026-08-13T08:00:00.000Z",
    cycleStartedAt: "2026-08-12T08:00:00.000Z",
    cycleEndedAt: "2026-08-13T08:00:00.000Z",
    finalizedAt: "2026-08-13T09:00:00.000Z",
    finalVoteCount: 5,
    rankInCycle: 2,
    ...overrides,
  };
}

test("canonical detail and media URLs use only the public Submission id", () => {
  assert.equal(getCommunityFeedDetailHref(17), "/spread/17");
  assert.equal(
    getCommunityFeedDetailMediaPath(17),
    "/api/community-feed/detail/media/17",
  );
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => getCommunityFeedDetailHref(invalid), TypeError);
  }
});

test("public detail DTO is exact and Live cannot claim final results", () => {
  assert.equal(isCommunityFeedDetail(detail()), true);
  assert.deepEqual(
    Object.keys(detail()).sort(),
    [...COMMUNITY_FEED_DETAIL_KEYS].sort(),
  );
  assert.equal(
    isCommunityFeedDetail(
      detail({
        state: "live",
        author: null,
        finalizedAt: null,
        finalVoteCount: null,
        rankInCycle: null,
      }),
    ),
    true,
  );
  for (const invalid of [
    detail({ discordId: "private" }),
    detail({ cycleId: 99 }),
    detail({ r2Key: "raw.webp" }),
    detail({ moderationReason: "private" }),
    detail({ author: { ...detail().author, discordUserId: "private" } }),
    detail({ author: { ...detail().author, avatarUrl: "https://cdn.example/avatar" } }),
    detail({ state: "live" }),
    detail({ imageUrl: "https://r2.example/raw.webp" }),
  ]) {
    assert.equal(isCommunityFeedDetail(invalid), false);
  }
});

test("detail delivery is service-only, fail-closed, and no-store", () => {
  const finalizedSelect = readModel.match(
    /const FINALIZED_DETAIL_SELECT = `[\s\S]*?`;/u,
  )?.[0] ?? "";
  const liveCycleQuery = readModel.match(
    /async function getCurrentLiveCycle[\s\S]*?return rows\[0\] \?\? null;/u,
  )?.[0] ?? "";
  assert.match(readModel, /^import "server-only";/u);
  assert.match(readModel, /supabaseAdmin/u);
  assert.match(readModel, /public_visibility_status", "visible"/u);
  assert.match(readModel, /is_disqualified\.is\.null,is_disqualified\.eq\.false/u);
  assert.match(readModel, /feed_eligible", true/u);
  assert.match(readModel, /COMMUNITY_FEED_CLASSIFICATION_VERSION/u);
  assert.match(readModel, /voting_cycles\.status", "finished"/u);
  assert.match(finalizedSelect, /\n    ended_at\n/u);
  assert.doesNotMatch(finalizedSelect, /\n    ends_at\n/u);
  assert.match(liveCycleQuery, /starts_at, ends_at, reset_count/u);
  assert.doesNotMatch(page, /discord(?:_user)?_?id|moderationReason|reportReason/iu);
  assert.doesNotMatch(
    readModel,
    /author:\s*\{[\s\S]*discord(?:UserId|_user_id)/iu,
  );
  assert.doesNotMatch(readModel, /\.rpc\(|\.insert\(|\.update\(|\.delete\(/u);
  assert.match(page, /dynamic = "force-dynamic"/u);
  assert.match(page, /revalidate = 0/u);
  assert.match(mediaRoute, /createNeutralCommunityFeedMediaResponse/u);
  assert.match(mediaRoute, /resolveCommunityFeedDetailMediaSource/u);
});

test("detail UI is modal-like, initially collapsed, and reserves comments below the metadata", () => {
  assert.match(page, /data-spread-detail-sponsor-slot/u);
  assert.match(page, /getCycleSponsoredMeta/u);
  assert.match(page, /"spread_detail"/u);
  assert.match(page, /<SponsoredBanner/u);
  assert.match(page, /format="feed"/u);
  assert.match(page, /label="Sponsored by"/u);
  assert.match(page, /data-spread-detail-community-slot/u);
  assert.match(page, /<details className=/u);
  assert.doesNotMatch(page, /<details\s+open/u);
  assert.match(page, /detail\.state === "finalized"/u);
  assert.match(page, /detail\.author/u);
  assert.match(page, /Submitted by/u);
  assert.match(page, /View public profile/u);
  assert.match(page, /Final rank/u);
  assert.match(page, /Final votes/u);
  assert.doesNotMatch(page, />\s*Finalized\s*</u);
  assert.doesNotMatch(page, />\s*The Spread\s*</u);
  assert.doesNotMatch(page, />\s*Meme detail\s*</u);
  assert.ok(
    page.indexOf("data-spread-detail-community-slot") >
      page.indexOf("spread-detail-metadata-title"),
  );
  assert.match(page, /CommunityFeedDetailCloseButton/u);
  assert.match(page, /z-\[80\]/u);
  assert.match(page, /data-hides-global-account/u);
  assert.match(closeButton, /ModalCloseButton/u);
  assert.match(closeButton, /router\.back\(\)/u);
  assert.match(closeButton, /router\.push\("\/spread"\)/u);
  assert.doesNotMatch(page, /<textarea/u);
  assert.match(notFound, /Meme unavailable/u);
  assert.doesNotMatch(notFound, /legal|disqual|removed|moderation|report/iu);
});

test("finalized author data is public-profile-only while Live stays anonymous", () => {
  assert.match(readModel, /detail\.state === "live"/u);
  assert.match(readModel, /author: null/u);
  assert.match(readModel, /getPreferredDiscordName/u);
  assert.match(readModel, /getPublicProfileAvatarPath/u);
  assert.match(readModel, /public_profile_id/u);
  assert.doesNotMatch(page, /knownDiscordUsernames|discordAvatar|avatarKey/iu);
});

test("Live, Top 10, All, and Trash cards share the same canonical destination", () => {
  assert.match(client, /getCommunityFeedDetailHref\(item\.submissionId\)/u);
  assert.doesNotMatch(client, /getCommunityFeedDetailHref\([^)]*feed/u);
});
