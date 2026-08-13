import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [page, client, route, surface, resume, navigation] = await Promise.all([
  readFile(new URL("app/spread/page.tsx", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedClient.tsx", root), "utf8"),
  readFile(new URL("app/api/community-feed/route.ts", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedSurface.server.ts", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedResume.ts", root), "utf8"),
  readFile(new URL("lib/navigation/homeNavigation.ts", root), "utf8"),
]);

test("Desktop and Mobile UI expose all four read-only Feed choices accessibly", () => {
  assert.match(client, /The Spread/u);
  assert.match(navigation, /label: "The Spread"[\s\S]*href: "\/spread"/u);
  assert.match(client, /aria-label="Community feeds"/u);
  assert.match(client, /aria-current=\{kind === feed \? "page"/u);
  assert.match(client, /role="feed"/u);
  assert.match(client, /role="article"/u);
  assert.match(client, /aria-busy=\{isLoading\}/u);
  assert.match(client, /role="status"/u);
  assert.match(client, /role="alert"/u);
  assert.match(client, /min-h-11/u);
  assert.match(client, /pointer-events-none fixed inset-x-0 top-0 z-40 h-44/u);
  assert.match(client, /linear-gradient\(to_bottom,#0b0b0b_0%,#0b0b0b_86%,transparent_100%\)/u);
  assert.match(client, /rounded-\[2rem\] border-2 border-orange-500\/70 bg-black\/95/u);
  assert.match(client, /aria-hidden="true" className="h-44"/u);
  assert.match(client, /sm:px-6|sm:text/u);
  for (const feed of ["live", "top10", "all", "trash"]) {
    assert.match(client, new RegExp(`COMMUNITY_FEED_LABELS\\[kind\\]|${feed}`, "u"));
  }
});

test("Resume is explicit, per Feed, semantic, dwell-based, and never a pixel position", () => {
  assert.match(client, /Continue where you left off/u);
  assert.match(client, /Start from the beginning/u);
  assert.match(client, /aria-label="Dismiss saved place"/u);
  assert.match(client, /resumedFromSavedPlace/u);
  assert.match(client, /await fetchPage\(\{\}\)/u);
  assert.match(client, /window\.history\.replaceState/u);
  assert.match(client, /Showing the newest submissions/u);
  assert.match(client, /getCommunityFeedResumeStorageKey\(feed\)/u);
  assert.match(client, /data-feed-submission-id/u);
  assert.match(client, /IntersectionObserver/u);
  assert.match(client, /COMMUNITY_FEED_VIEWPORT_THRESHOLD/u);
  assert.match(client, /COMMUNITY_FEED_VIEWPORT_DWELL_MS/u);
  assert.match(client, /COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS/u);
  assert.match(resume, /cycleId: context\.cycleId/u);
  assert.match(resume, /resetCount: context\.resetCount/u);
  assert.doesNotMatch(`${client}\n${resume}`, /scrollY|scrollTop|pixelOffset/iu);
});

test("Feed cards keep direct anchors internal until a real detail surface exists", () => {
  assert.doesNotMatch(client, /Open link|Open submission/u);
  assert.match(surface, /resolveCommunityFeedAnchor/u);
});

test("direct anchors, Reload fallback, and Cycle/reset expiry stay bounded", () => {
  assert.match(page, /anchorSubmissionId/u);
  assert.match(route, /params\.get\("anchor"\)/u);
  assert.match(surface, /resolveCommunityFeedAnchor/u);
  assert.match(surface, /getCommunityFeedPage/u);
  assert.doesNotMatch(surface, /while\s*\(|loadUntil|offset/iu);
  assert.match(client, /anchor_unavailable_reset/u);
  assert.match(client, /context_unavailable_reset/u);
  assert.match(client, /Cycle changed or reset/u);
  assert.match(client, /window\.localStorage\.removeItem/u);
});

test("cursor pagination and prefetching keep at most one nearby signed page", () => {
  assert.match(client, /prefetchRef = useRef/u);
  assert.match(client, /rootMargin: "600px 0px"/u);
  assert.match(client, /params\.set\("cursor", cursor\)/u);
  assert.match(client, /mergeCommunityFeedItems/u);
  assert.match(client, /LoadMoreButton/u);
  assert.doesNotMatch(client, /while\s*\(|Promise\.all\([^)]*cursor/iu);
  assert.match(route, /export async function GET/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
});

test("media boxes are stable and placeholders prevent scroll jumps", () => {
  assert.match(client, /aspectRatio/u);
  assert.match(client, /mediaWidth/u);
  assert.match(client, /mediaHeight/u);
  assert.match(client, /width=\{hasDimensions/u);
  assert.match(client, /height=\{hasDimensions/u);
  assert.match(client, /loading=\{position === 1 \? "eager" : "lazy"\}/u);
  assert.match(client, /Submission image unavailable/u);
  assert.match(client, /object-contain/u);
});

test("Phase 3 adds no mutation, database access, comments, PWA, Sponsor tracking, or private DTO", () => {
  const publicSurface = `${page}\n${client}\n${route}\n${surface}\n${resume}`;
  assert.match(surface, /^import "server-only";/u);
  assert.match(surface, /communityFeedReadModel\.server/u);
  assert.doesNotMatch(
    publicSurface,
    /supabaseAdmin|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|query\.delete\(/u,
  );
  assert.doesNotMatch(
    publicSurface,
    /discord(?:_user)?_?id|moderationReason|reportReason|viewerHash|walletAddress|sponsorImpression|comment(?:s|Vote)/iu,
  );
  assert.doesNotMatch(publicSurface, /manifest\.webmanifest|serviceWorker|beforeinstallprompt/u);
  assert.doesNotMatch(client, /SponsorImpressionTracker|SponsoredBanner/u);
});
