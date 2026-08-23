import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [page, client, actions, shareHelper, navigator, route, surface, resume, navigation, detailPage, layout, globalStyles] = await Promise.all([
  readFile(new URL("app/spread/page.tsx", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedClient.tsx", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedCardActions.tsx", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedShare.ts", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedCycleNavigator.tsx", root), "utf8"),
  readFile(new URL("app/api/community-feed/route.ts", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedSurface.server.ts", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedResume.ts", root), "utf8"),
  readFile(new URL("lib/navigation/homeNavigation.ts", root), "utf8"),
  readFile(new URL("app/spread/[submissionId]/page.tsx", root), "utf8"),
  readFile(new URL("app/layout.tsx", root), "utf8"),
  readFile(new URL("app/globals.css", root), "utf8"),
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
  assert.match(`${client}\n${navigator}`, /role="alert"/u);
  assert.match(client, /min-h-11/u);
  assert.match(client, /pointer-events-none fixed inset-x-0 top-0 z-40 h-56 lg:h-40/u);
  assert.match(client, /linear-gradient\(to_bottom,#0b0b0b_0%,#0b0b0b_86%,transparent_100%\)/u);
  assert.match(client, /rounded-\[2rem\] border-2 border-orange-500\/70 bg-black\/95/u);
  assert.match(client, /aria-hidden="true" className="h-56 lg:h-40"/u);
  assert.match(client, /sm:px-6|sm:text/u);
  for (const feed of ["live", "top10", "all", "trash"]) {
    assert.match(client, new RegExp(`COMMUNITY_FEED_LABELS\\[kind\\]|${feed}`, "u"));
  }
});

test("finalized Resume is explicit, semantic, dwell-based, and never a pixel position", () => {
  assert.match(navigator, /Continue where you left off/u);
  assert.match(navigator, /Start from the beginning/u);
  assert.match(navigator, /aria-label="Dismiss saved place"/u);
  assert.match(client, /if \(feed === "live" \|\| initialAnchorRequested\) return;/u);
  assert.match(client, /resumedFromSavedPlace/u);
  assert.match(client, /await fetchPage\(\{\}\)/u);
  assert.match(client, /window\.history\.replaceState/u);
  assert.match(client, /Showing the newest submissions/u);
  assert.match(client, /getCommunityFeedResumeStorageKey\(feed, cycleNumber\)/u);
  assert.match(client, /data-feed-submission-id/u);
  assert.match(client, /IntersectionObserver/u);
  assert.match(client, /COMMUNITY_FEED_VIEWPORT_THRESHOLD/u);
  assert.match(client, /COMMUNITY_FEED_VIEWPORT_DWELL_MS/u);
  assert.match(client, /COMMUNITY_FEED_PROGRESS_DEBOUNCE_MS/u);
  assert.match(resume, /cycleNumber: context\.cycleNumber/u);
  assert.match(resume, /resetCount: context\.resetCount/u);
  assert.match(resume, /cycle-\$\{cycleNumber \?\? "all"\}/u);
  assert.doesNotMatch(`${client}\n${navigator}\n${resume}`, /scrollY|scrollTop|pixelOffset/iu);
});

test("Feed cards open the canonical detail route without nested Sponsor interaction", () => {
  assert.match(client, /getCommunityFeedDetailHref\(item\.submissionId\)/u);
  assert.match(client, /aria-label="Open meme details"/u);
  assert.ok(
    client.indexOf("</Link>") < client.indexOf("<CommunityFeedSponsor"),
  );
  assert.doesNotMatch(client, /Cycle #\{item\.cycleNumber\}|Rank #|<time/u);
  assert.match(detailPage, /getCommunityFeedDetailPageData\(submissionId\)/u);
  assert.match(detailPage, /<SponsoredBanner/u);
  assert.match(surface, /resolveCommunityFeedAnchor/u);
});

test("Feed cards use the CancerCulture shell and preserve breathing room for future actions", () => {
  assert.match(client, /border-2 border-orange-500\/35 bg-black\/80 p-1/u);
  assert.match(client, /hover:border-orange-400\/60/u);
  assert.match(client, /space-y-8 sm:space-y-10/u);
  assert.ok(
    client.indexOf("</Link>") < client.indexOf("<CommunityFeedSponsor"),
  );
  assert.match(client, /<CommunityFeedCardActions/u);
  assert.doesNotMatch(client, />Comments</u);
});

test("Feed actions use native sharing, keep Copy Link visible, and batch-load private saved state", () => {
  assert.match(shareHelper, /navigatorImpl\.share/u);
  assert.match(shareHelper, /navigatorImpl\.canShare/u);
  assert.match(shareHelper, /getCommunityFeedDetailMediaPath/u);
  assert.match(actions, /shareCommunityFeedMeme/u);
  assert.match(actions, />\s*Copy Link\s*</u);
  assert.doesNotMatch(
    `${actions}\n${shareHelper}`,
    /facebook|whatsapp|telegram|signal|More apps|t\.me|wa\.me/iu,
  );
  assert.match(actions, /shareBusyRef\.current/u);
  assert.match(actions, /if \(shareBusyRef\.current\) return/u);
  assert.match(actions, /aria-busy=\{shareBusy\}/u);
  assert.match(actions, /method: saved \? "DELETE" : "PUT"/u);
  assert.match(actions, /requestIdentityRef/u);
  assert.match(client, /\/api\/account\/saved-memes\/status\?submissionIds=/u);
  assert.match(client, /cache: "no-store"/u);
  assert.match(client, /knownSavedSubmissionIds/u);
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

test("global smooth scrolling declares its route-transition contract", () => {
  assert.match(globalStyles, /scroll-behavior:\s*smooth/u);
  assert.match(layout, /data-scroll-behavior="smooth"/u);
});

test("finalized Cycle selection is canonical in URL, transport, anchors, and navigation", () => {
  assert.match(page, /cycle\?: string \| string\[\]/u);
  assert.match(page, /cycleNumber=\{cycleNumber\}/u);
  assert.match(page, /getCommunityFeedSurfacePage\(\{[\s\S]*cycleNumber/u);
  assert.match(client, /params\.set\("cycle", String\(cycleNumber\)\)/u);
  assert.match(client, /getCommunityFeedHref\([\s\S]*cycleNumber/u);
  assert.match(client, /readPageResponse\(response, feed, cycleNumber\)/u);
  assert.doesNotMatch(`${page}\n${client}`, /cycleId|cycle_id/u);
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
  assert.match(client, /Meme image unavailable/u);
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
