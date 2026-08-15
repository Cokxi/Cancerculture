import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [client, navigator, page, backButton, surface] = await Promise.all([
  readFile(new URL("app/spread/CommunityFeedClient.tsx", root), "utf8"),
  readFile(
    new URL("app/spread/CommunityFeedCycleNavigator.tsx", root),
    "utf8",
  ),
  readFile(new URL("app/spread/page.tsx", root), "utf8"),
  readFile(new URL("app/components/ui/BackButton.tsx", root), "utf8"),
  readFile(new URL("lib/feed/communityFeedSurface.ts", root), "utf8"),
]);

test("finalized Feeds alone expose the responsive Cycle navigator", () => {
  assert.match(client, /const finalizedFeed = feed === "live" \? null : feed/u);
  assert.match(client, /finalizedFeed \? \(/u);
  assert.match(client, /CommunityFeedCycleNavigatorButton/u);
  assert.match(client, /CommunityFeedCycleNavigatorDrawer/u);
  assert.match(client, /aria-label="Finalized Cycle navigator"/u);
  assert.match(client, /hidden lg:block/u);
  assert.match(
    client,
    /lg:grid-cols-\[15rem_minmax\(0,48rem\)\]/u,
  );
  assert.match(client, /hidden lg:block lg:self-stretch/u);
  assert.match(
    client,
    /fixed top-40 w-60 max-h-\[calc\(100dvh-11rem\)\] overflow-y-auto overscroll-contain \[scrollbar-gutter:stable\]/u,
  );
  assert.match(client, /left: "max\(1\.5rem, calc\(50% - 32\.5rem\)\)"/u);
  assert.match(navigator, /bg-black\/95/u);
  assert.match(navigator, /fixed inset-x-0 bottom-0 top-16 z-\[60\] lg:hidden/u);
  assert.match(navigator, /max-h-\[calc\(100dvh-4rem\)\]/u);
});

test("the navigator uses only the bounded public catalog with controlled deduplicated pagination", () => {
  assert.match(client, /fetch\(`\/api\/community-feed\/cycles\$\{query\}`/u);
  assert.match(client, /cache: "no-store"/u);
  assert.match(client, /isCommunityFeedCycleCatalogPage\(value\)/u);
  assert.match(client, /mergeCommunityFeedCycleCatalogItems/u);
  assert.match(client, /catalogPage\.nextCursor/u);
  assert.match(client, /catalogPage\.hasMore/u);
  assert.match(navigator, /Load older Cycles/u);
  assert.match(navigator, /Retry Cycle catalog/u);
  assert.match(navigator, /Loading finalized Cycles/u);
  assert.match(navigator, /No finalized Cycles are available yet/u);
  assert.doesNotMatch(`${client}\n${navigator}`, /while\s*\(/iu);
  assert.doesNotMatch(navigator, /community-feed\?(?:[^\n]*cursor|[^\n]*anchor)/u);
});

test("All Cycles, exact selections, direct jump, and Feed switches share canonical URLs", () => {
  assert.match(navigator, /All Cycles/u);
  assert.match(navigator, /Jump to Cycle number/u);
  assert.match(navigator, /action="\/spread" method="get"/u);
  assert.match(navigator, /name="feed" value=\{feed\}/u);
  assert.match(navigator, /name="cycle"/u);
  assert.match(navigator, /pattern="\[1-9\]\[0-9\]\*"/u);
  assert.match(navigator, /getCommunityFeedHref\(feed\)/u);
  assert.match(
    navigator,
    /getCommunityFeedHref\([\s\S]*feed,[\s\S]*undefined,[\s\S]*item\.cycleNumber/u,
  );
  assert.match(client, /kind === "live" \? null : cycleNumber/u);
  assert.match(navigator, /aria-current=\{active \? "page"/u);
  assert.match(navigator, /Selected by direct link/u);
});

test("Cycle labels are grouped into visible ten-Cycle ranges with totals and public dates only", () => {
  assert.match(navigator, /groupCommunityFeedCyclesByNumberRange\(items\)/u);
  assert.match(navigator, /Cycles \{group\.rangeStart\}–\{group\.rangeEnd\}/u);
  assert.match(navigator, /totalCount/u);
  assert.match(navigator, /finalized \{totalCount === 1 \? "Cycle" : "Cycles"\}/u);
  assert.match(navigator, /Cycle #\{item\.cycleNumber\}/u);
  assert.match(navigator, /formatCommunityFeedCycleDateRange\(item\)/u);
  assert.match(
    surface,
    /return `\$\{start\.day\}\\u2013\$\{end\.day\} \$\{start\.month\} \$\{start\.year\}`/u,
  );
  assert.doesNotMatch(
    navigator,
    /sponsor|purchase|cycleId|cycle_id|discord|moderation|report/iu,
  );
});

test("Mobile focus, Escape, close, keyboard navigation, and target sizes are explicit", () => {
  assert.match(navigator, /role="dialog"/u);
  assert.match(navigator, /aria-modal="true"/u);
  assert.match(navigator, /event\.key === "Escape"/u);
  assert.match(navigator, /event\.key !== "Tab"/u);
  assert.match(navigator, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(navigator, /triggerRef\.current\?\.focus\(\)/u);
  assert.match(navigator, /event\.key !== "ArrowDown" && event\.key !== "ArrowUp"/u);
  assert.match(navigator, /min-h-11/u);
  assert.match(navigator, /min-w-11/u);
});

test("finalized Resume is prominent inside the navigator and absent from Live", () => {
  assert.match(navigator, /Saved place controls/u);
  assert.match(navigator, /Resume where you left off/u);
  assert.match(navigator, /aria-label="Continue where you left off"/u);
  assert.match(navigator, /aria-label="Dismiss saved place"/u);
  assert.match(navigator, /aria-label="Start from the beginning"/u);
  assert.match(navigator, /Back to latest/u);
  assert.match(client, /hasSavedPlace=\{resumeRecord !== null\}/u);
  assert.match(client, /if \(feed === "live" \|\| initialAnchorRequested\) return;/u);
  assert.match(client, /if \(feed === "live"\) return;/u);
  assert.match(client, /clearSavedProgress\(\)/u);
  assert.doesNotMatch(client, /CommunityFeedResumeControls/u);
});

test("the Spread Home control alone uses exact native top navigation and leaves Back restoration native", () => {
  assert.match(page, /<BackButton href="\/" label="Home" nativeNavigation \/>/u);
  assert.match(backButton, /if \(nativeNavigation\)[\s\S]*<a href=\{href\}/u);
  assert.doesNotMatch(`${page}\n${backButton}`, /scrollRestoration|router\.back/u);
  assert.doesNotMatch(`${page}\n${backButton}`, /behavior:\s*"smooth"|scroll-smooth/u);
});

test("browser-visible navigator and resume code keep the public privacy allowlist", () => {
  const publicUi = `${client}\n${navigator}\n${surface}`;
  assert.doesNotMatch(
    publicUi,
    /discord(?:_user)?_?id|moderationReason|reportReason|viewerHash|walletAddress/iu,
  );
  assert.doesNotMatch(`${client}\n${navigator}`, /cycleId|cycle_id/u);
});
