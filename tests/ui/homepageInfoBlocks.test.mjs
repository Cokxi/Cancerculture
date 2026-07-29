import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Homepage replaces static cards with a non-blocking server stream", async () => {
  const [home, renderer] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile(
      "app/components/homepageInfoBlocks/HomeInfoBlocks.tsx"
    ),
  ]);

  assert.match(home, /const infoBlocksPromise = getActiveHomepageInfoBlocks\(\)/);
  assert.match(
    home,
    /id="info"\s+data-home-section="info"[\s\S]*?<Suspense fallback=\{null\}>[\s\S]*?<HomeInfoBlocks\s+infoBlocksPromise=\{infoBlocksPromise\}/
  );
  assert.doesNotMatch(home, /CancerCulture is a community-driven meme competition/);
  assert.doesNotMatch(home, /Each cycle is a standalone meme competition/);
  assert.match(renderer, /blocks = await infoBlocksPromise/);
  assert.match(renderer, /<div className="home-info-block-list">/);
  assert.match(renderer, /blocks\.map\(\(block\) =>/);
  assert.match(renderer, /catch \{[\s\S]*?return null;/);
  assert.doesNotMatch(renderer, /orange-info-box/);
});

test("public cards preserve plain text, optional safe links, and single-column width", async () => {
  const [home, renderer, card, styles] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile(
      "app/components/homepageInfoBlocks/HomeInfoBlocks.tsx"
    ),
    readRepoFile(
      "app/components/homepageInfoBlocks/HomepageInfoBlockCard.tsx"
    ),
    readRepoFile("app/globals.css"),
  ]);

  assert.match(home, /className="home-info-section/);
  assert.doesNotMatch(home, /data-home-section="info"[\s\S]*?md:grid-cols-2/);
  assert.match(renderer, /className="home-info-block-list"/);
  assert.match(
    styles,
    /\.home-info-block-list\s*\{[\s\S]*?flex-direction: column;[\s\S]*?align-items: center;[\s\S]*?gap: var\(--home-info-card-gap\);/
  );
  assert.match(styles, /--home-info-card-max-width: 660px/);
  assert.match(
    styles,
    /\.orange-info-box--home\s*\{[\s\S]*?max-width: var\(--home-info-card-max-width\);/
  );
  assert.match(card, /orange-info-box--home/);
  assert.match(card, /whitespace-pre-wrap/);
  assert.match(card, /\{block\.body\}/);
  assert.doesNotMatch(card, /dangerouslySetInnerHTML/);
  assert.match(card, /block\.linkLabel && block\.linkUrl/);
  assert.match(card, /target="_blank"/);
  assert.match(card, /rel="noopener noreferrer"/);
  assert.match(card, /cursor-pointer/);
  assert.match(card, /focus-visible:ring-2/);
});
