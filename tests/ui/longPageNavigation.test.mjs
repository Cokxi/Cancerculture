import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  const [rulesPage, rulesContent, navigation] = await Promise.all([
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("app/content/rules.ts"),
    readRepoFile("app/components/navigation/SectionNavigation.tsx"),
  ]);

  for (const id of ruleSectionIds) {
    assert.match(rulesContent, new RegExp(`id: "${id}"`));
  }

  assert.equal(
    [...rulesContent.matchAll(/\bid: "([^"]+)"/g)].length,
    ruleSectionIds.length
  );
  assert.match(rulesPage, /id=\{id\}/);
  assert.match(rulesPage, /sections=\{standardRulesSections\}/);
  assert.match(navigation, /href=\{`#\$\{section\.id\}`\}/);
  assert.doesNotMatch(navigation, /sticky|scrollIntoView/);
});

test("FAQ and Rules share wrapping hash navigation with scroll offsets", async () => {
  const [faq, rules, navigation] = await Promise.all([
    readRepoFile("app/faq/page.tsx"),
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("app/components/navigation/SectionNavigation.tsx"),
  ]);

  assert.match(faq, /sections=\{faqSections\}/);
  assert.match(rules, /sections=\{standardRulesSections\}/);
  assert.match(faq, /scroll-mt-24.*sm:scroll-mt-28/);
  assert.match(rules, /scroll-mt-24.*sm:scroll-mt-28/);
  assert.match(navigation, /flex max-w-full flex-wrap gap-3/);
  assert.match(navigation, /cursor-pointer/);
  assert.match(navigation, /focus-visible:ring-2/);
  assert.match(navigation, /active:bg-\[#2a1007\]/);
  assert.doesNotMatch(faq, /sticky|scrollIntoView/);
  assert.doesNotMatch(rules, /sticky|scrollIntoView/);
});

test("shared back-to-top control is hidden initially and appears after a bounded threshold", async () => {
  const [faq, rules, backToTop, globalStyles] = await Promise.all([
    readRepoFile("app/faq/page.tsx"),
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("app/components/ui/BackToTopButton.tsx"),
    readRepoFile("app/globals.css"),
  ]);

  assert.match(faq, /<BackToTopButton \/>/);
  assert.match(rules, /<BackToTopButton \/>/);
  assert.match(backToTop, /useState\(false\)/);
  assert.match(backToTop, /SHOW_AFTER_PX = 480/);
  assert.match(backToTop, /if \(!isVisible\) return null/);
  assert.match(backToTop, /requestAnimationFrame\(updateVisibility\)/);
  assert.match(backToTop, /\{ passive: true \}/);
  assert.match(backToTop, /removeEventListener\("scroll"/);
  assert.match(backToTop, /cancelAnimationFrame\(animationFrame\)/);
  assert.match(backToTop, /aria-label="Back to top"/);
  assert.match(backToTop, /safe-area-inset-bottom/);
  assert.match(backToTop, /navigationTriggerBaseClassName/);
  assert.match(backToTop, /prefers-reduced-motion: reduce/);
  assert.match(backToTop, /reduceMotion \? "instant" : "smooth"/);
  assert.match(globalStyles, /prefers-reduced-motion: reduce/);
});
