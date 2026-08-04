import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BACK_TO_TOP_SCROLL_THRESHOLD_PX,
  shouldShowBackToTop,
} from "../../lib/navigation/backToTopVisibility.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const ruleSectionIds = [
  "participation",
  "submissions",
  "fair-play",
  "behavior",
  "rewards",
  "charity-public-profiles",
  "moderation",
  "technical-limits",
  "disclaimer",
  "final-note",
];

test("Rules exposes stable navigation for every major section", async () => {
  const [rulesPage, rulesView, migration, navigation] = await Promise.all([
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("app/components/content/RulesDocumentView.tsx"),
    readRepoFile(
      "supabase/migrations/20260804000100_dynamic_rules_content_management.sql"
    ),
    readRepoFile("app/components/navigation/SectionNavigation.tsx"),
  ]);

  for (const id of ruleSectionIds) {
    assert.match(migration, new RegExp(`"id": "${id}"`));
  }

  assert.equal(
    [...migration.matchAll(/"id": "([^"]+)"/g)].length,
    ruleSectionIds.length
  );
  assert.match(rulesPage, /getPublishedRulesContent/);
  assert.match(rulesView, /id=\{section\.id\}/);
  assert.match(rulesView, /sections=\{document\.sections\}/);
  assert.match(navigation, /href=\{`#\$\{section\.id\}`\}/);
  assert.doesNotMatch(navigation, /sticky|scrollIntoView/);
});

test("FAQ and Rules share wrapping hash navigation with scroll offsets", async () => {
  const [faqPage, faqView, rulesView, navigation] = await Promise.all([
    readRepoFile("app/faq/page.tsx"),
    readRepoFile("app/components/content/FaqDocumentView.tsx"),
    readRepoFile("app/components/content/RulesDocumentView.tsx"),
    readRepoFile("app/components/navigation/SectionNavigation.tsx"),
  ]);

  assert.match(faqPage, /getPublishedFaqContent/);
  assert.match(faqView, /sections=\{document\.sections\}/);
  assert.match(rulesView, /sections=\{document\.sections\}/);
  assert.match(faqView, /scroll-mt-24.*sm:scroll-mt-28/);
  assert.match(rulesView, /scroll-mt-24.*sm:scroll-mt-28/);
  assert.match(navigation, /flex max-w-full flex-wrap gap-3/);
  assert.match(navigation, /cursor-pointer/);
  assert.match(navigation, /focus-visible:ring-2/);
  assert.match(navigation, /active:bg-\[#2a1007\]/);
  assert.doesNotMatch(faqView, /sticky|scrollIntoView/);
  assert.doesNotMatch(rulesView, /sticky|scrollIntoView/);
});

test("one shared back-to-top control covers public routes without entering Admin", async () => {
  const [rootLayout, faq, rules, backToTop] = await Promise.all([
    readRepoFile("app/layout.tsx"),
    readRepoFile("app/faq/page.tsx"),
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("app/components/ui/BackToTopButton.tsx"),
  ]);

  assert.equal(rootLayout.match(/<BackToTopButton \/>/g)?.length, 1);
  assert.doesNotMatch(faq, /BackToTopButton/);
  assert.doesNotMatch(rules, /BackToTopButton/);
  assert.match(backToTop, /usePathname\(\)/);
  assert.match(backToTop, /pathname === "\/admin"/);
  assert.match(backToTop, /pathname\.startsWith\("\/admin\/"\)/);
  assert.match(backToTop, /if \(isAdminPath \|\| !isVisible\) return null/);
});

test("back-to-top visibility follows document height and the bounded scroll threshold", () => {
  assert.equal(BACK_TO_TOP_SCROLL_THRESHOLD_PX, 480);

  assert.equal(
    shouldShowBackToTop({
      scrollY: 600,
      scrollHeight: 900,
      viewportHeight: 800,
    }),
    false,
    "short pages stay hidden even with a synthetic deep scroll"
  );
  assert.equal(
    shouldShowBackToTop({
      scrollY: 0,
      scrollHeight: 1800,
      viewportHeight: 800,
    }),
    false,
    "long pages stay hidden at the top"
  );
  assert.equal(
    shouldShowBackToTop({
      scrollY: 480,
      scrollHeight: 1800,
      viewportHeight: 800,
    }),
    true,
    "long pages become visible at the threshold"
  );
  assert.equal(
    shouldShowBackToTop({
      scrollY: 0,
      scrollHeight: 1800,
      viewportHeight: 800,
    }),
    false,
    "returning to the top hides the control"
  );
});

test("dynamically grown pages are re-evaluated without network or polling work", async () => {
  const backToTop = await readRepoFile(
    "app/components/ui/BackToTopButton.tsx"
  );

  const beforeGrowth = shouldShowBackToTop({
    scrollY: 520,
    scrollHeight: 900,
    viewportHeight: 800,
  });
  const afterGrowth = shouldShowBackToTop({
    scrollY: 520,
    scrollHeight: 1800,
    viewportHeight: 800,
  });

  assert.equal(beforeGrowth, false);
  assert.equal(afterGrowth, true);
  assert.match(backToTop, /new ResizeObserver\(handleScroll\)/);
  assert.match(backToTop, /observe\(document\.documentElement\)/);
  assert.match(backToTop, /observe\(document\.body\)/);
  assert.match(backToTop, /requestAnimationFrame\(updateVisibility\)/);
  assert.match(backToTop, /\{ passive: true \}/);
  assert.doesNotMatch(
    backToTop,
    /fetch\(|supabase|setInterval|setTimeout|localStorage|EventSource|WebSocket/
  );
});

test("back-to-top interaction, reduced motion, and cleanup remain accessible", async () => {
  const [backToTop, navigationStyles, globalStyles] = await Promise.all([
    readRepoFile("app/components/ui/BackToTopButton.tsx"),
    readRepoFile(
      "app/components/navigation/navigationButtonStyles.ts"
    ),
    readRepoFile("app/globals.css"),
  ]);

  assert.match(backToTop, /useState\(false\)/);
  assert.match(backToTop, /removeEventListener\("scroll"/);
  assert.match(backToTop, /removeEventListener\("resize"/);
  assert.match(backToTop, /resizeObserver\?\.disconnect\(\)/);
  assert.match(backToTop, /cancelAnimationFrame\(animationFrame\)/);
  assert.match(backToTop, /aria-label="Back to top"/);
  assert.match(backToTop, /safe-area-inset-bottom/);
  assert.match(backToTop, /navigationTriggerBaseClassName/);
  assert.match(backToTop, /prefers-reduced-motion: reduce/);
  assert.match(backToTop, /reduceMotion \? "instant" : "smooth"/);
  assert.match(backToTop, /window\.scrollTo\(\{\s*top: 0,/);
  assert.match(navigationStyles, /cursor-pointer/);
  assert.match(navigationStyles, /hover:/);
  assert.match(navigationStyles, /focus-visible:ring-2/);
  assert.match(navigationStyles, /active:/);
  assert.match(globalStyles, /prefers-reduced-motion: reduce/);
});
