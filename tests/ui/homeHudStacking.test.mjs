import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const sectionClassName = (source, section) => {
  const match = source.match(
    new RegExp(
      `<section\\s+(?:id="[^"]+"\\s+)?data-home-section="${section}"\\s+className="([\\s\\S]*?)"`
    )
  );

  assert.ok(match, `missing ${section} home section`);
  return match[1];
};

const cssRule = (source, selector) => {
  const match = source.match(
    new RegExp(
      `\\.${selector.replaceAll("-", "\\-")}\\s*\\{([\\s\\S]*?)\\}`
    )
  );

  assert.ok(match, `missing .${selector} CSS rule`);
  return match[1];
};

test("stable Hero precedes the independently sized dynamic content", async () => {
  const home = await readRepoFile("app/page.tsx");
  const renderedHome = home.slice(
    home.indexOf("export default function Home()")
  );
  const cycle = renderedHome.indexOf('data-home-section="cycle"');
  const characters = renderedHome.indexOf(
    'data-home-section="characters"'
  );
  const brand = renderedHome.indexOf('data-home-section="brand"');
  const dynamic = renderedHome.indexOf("data-home-dynamic");
  const coin = renderedHome.indexOf("<HomePrimaryCoinLaunch");
  const info = renderedHome.indexOf('data-home-section="info"');

  assert.ok(cycle >= 0);
  assert.ok(characters > cycle);
  assert.ok(brand > characters);
  assert.ok(dynamic > brand);
  assert.ok(coin > dynamic);
  assert.ok(info > coin);
  assert.match(
    renderedHome,
    /data-home-stack className="home-page-layout"/
  );
  assert.match(renderedHome, /data-home-hero className="home-hero"/);
  assert.match(
    renderedHome,
    /data-home-dynamic className="home-dynamic-content"/
  );
  assert.doesNotMatch(
    renderedHome,
    /min-h-screen|h-screen|justify-between|translate-y|mt-\[-|mb-\[-/
  );
});

test("one central variable set controls Hero geometry and HUD reservation", async () => {
  const [home, styles, cycleHud, coinLaunch] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile("app/globals.css"),
    readRepoFile("app/components/CycleHud.tsx"),
    readRepoFile("app/components/CoinLaunchDisplay.tsx"),
  ]);

  for (const section of ["cycle", "characters", "brand", "info"]) {
    const classes = sectionClassName(home, section);
    assert.doesNotMatch(
      classes,
      /\b(?:absolute|fixed|top-|bottom-|inset-|translate-y|mt-\[-|mb-\[-|h-screen|min-h-screen|justify-between)\b/
    );
  }

  const pageLayout = cssRule(styles, "home-page-layout");
  const hero = cssRule(styles, "home-hero");
  const hudSlot = cssRule(styles, "home-hero__hud");
  const characters = cssRule(styles, "home-hero__characters");
  const brand = cssRule(styles, "home-hero__brand");
  const dynamic = cssRule(styles, "home-dynamic-content");
  const infoSection = cssRule(styles, "home-info-section");

  for (const variable of [
    "--home-top-space",
    "--home-hud-slot",
    "--home-hud-content-offset",
    "--home-hero-gap",
    "--home-brand-content-gap",
    "--home-info-section-top-space",
    "--home-info-card-gap",
    "--home-info-card-max-width",
  ]) {
    assert.match(pageLayout, new RegExp(`${variable}:`));
  }

  assert.match(pageLayout, /padding:\s*[\s\S]*var\(--home-top-space\)/);
  assert.match(pageLayout, /--home-hud-slot: 14rem/);
  assert.match(pageLayout, /--home-hud-content-offset: 2\.75rem/);
  assert.match(hero, /row-gap: var\(--home-hero-gap\)/);
  assert.match(hudSlot, /min-block-size: var\(--home-hud-slot\)/);
  assert.match(hudSlot, /align-items: flex-start/);
  assert.match(
    hudSlot,
    /padding-block-start: var\(--home-hud-content-offset\)/
  );
  assert.match(
    dynamic,
    /margin-block-start: var\(--home-brand-content-gap\)/
  );
  assert.doesNotMatch(dynamic, /\bgap:/);
  assert.match(
    infoSection,
    /margin-block-start: var\(--home-info-section-top-space\)/
  );
  assert.match(
    pageLayout,
    /--home-brand-content-gap: clamp\(5rem, 6vw, 7rem\)/
  );
  assert.match(
    pageLayout,
    /--home-info-section-top-space: clamp\(5\.5rem, 7vw, 7\.5rem\)/
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.home-page-layout\s*\{[\s\S]*?--home-hud-slot: 15rem;[\s\S]*?--home-hud-content-offset: 3\.25rem;[\s\S]*?--home-brand-content-gap: 4\.5rem;[\s\S]*?--home-info-section-top-space: 5\.5rem;/
  );

  for (const rule of [
    pageLayout,
    hero,
    hudSlot,
    characters,
    brand,
    dynamic,
    infoSection,
  ]) {
    assert.doesNotMatch(
      rule,
      /position:\s*(?:absolute|fixed)|translate|margin[^:]*:\s*-|min-height:\s*100(?:s|d|l)?vh|height:\s*100(?:s|d|l)?vh/
    );
  }

  assert.match(cycleHud, /pointer-events-none flex w-full justify-center/);
  assert.match(cycleHud, /max-w-\[88vw\].*break-words/);
  assert.match(cycleHud, /className="pointer-events-auto text-green-400/);
  assert.doesNotMatch(
    cycleHud,
    /pointer-events-none (?:absolute|fixed)|\b(?:inset|top|bottom)-/
  );
  assert.doesNotMatch(
    coinLaunch,
    /\b(?:fixed|absolute|bottom-|top-|translate-y|translate-x)/
  );
});

test("HUD fallback inherits the slot and every current HUD row can grow safely", async () => {
  const [home, cycleHud, styles] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile("app/components/CycleHud.tsx"),
    readRepoFile("app/globals.css"),
  ]);
  const fallback = home.slice(
    home.indexOf("function CycleHudFallback()"),
    home.indexOf("async function HomeCycleHud")
  );
  const hudSlot = cssRule(styles, "home-hero__hud");

  assert.match(fallback, /home-hero__hud-fallback/);
  assert.doesNotMatch(
    fallback,
    /\b(?:h-|min-h-|max-h-)\[?[\d]|style=\{\{[^}]*height/
  );
  assert.match(hudSlot, /min-block-size: var\(--home-hud-slot\)/);
  assert.doesNotMatch(hudSlot, /(?:max-)?height:|overflow:\s*hidden/);
  assert.match(cycleHud, /if \(!cycle \|\| !displayState\) return null/);
  assert.match(cycleHud, /<CycleCountdown endAt=\{displayState\.timerEndAt\}/);
  assert.match(cycleHud, /Presented by:/);
  assert.match(cycleHud, /Votes per user:/);
  assert.match(cycleHud, /Next Theme:/);
  for (const status of [
    "SUBMISSION OPEN",
    "VOTING OPEN",
    "PAUSED",
    "COMPLETED",
    "FINALIZED",
  ]) {
    assert.match(cycleHud, new RegExp(status));
  }
});

test("cell media cannot intercept input while their intentional links remain interactive", async () => {
  const cells = await Promise.all(
    [
      "app/components/DiscordCellAnimated.tsx",
      "app/components/TelegramCellAnimated.tsx",
    ].map(readRepoFile)
  );

  for (const cell of cells) {
    assert.match(
      cell,
      /className="group relative block w-full cursor-pointer"/
    );
    assert.match(cell, /pointer-events-none/);
    assert.match(cell, /\bw-full\b/);
    assert.doesNotMatch(cell, /w-\[400px\]/);
  }
});

test("characters stay responsive while Homepage cards form a narrow one-column list", async () => {
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
  const characters = sectionClassName(home, "characters");
  const info = sectionClassName(home, "info");
  const characterStyles = cssRule(styles, "home-hero__characters");
  const listStyles = cssRule(styles, "home-info-block-list");
  const homeCardStyles = cssRule(styles, "orange-info-box--home");
  const baseCardStyles = cssRule(styles, "orange-info-box");

  assert.equal(characters.trim(), "home-hero__characters");
  assert.match(
    characterStyles,
    /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(characterStyles, /place-items: center/);
  assert.equal(
    info.trim(),
    "home-info-section scroll-mt-24 md:scroll-mt-28"
  );
  assert.match(renderer, /<div className="home-info-block-list">/);
  assert.match(renderer, /blocks\.map\(\(block\) =>/);
  assert.match(listStyles, /flex-direction: column/);
  assert.match(listStyles, /align-items: center/);
  assert.match(listStyles, /gap: var\(--home-info-card-gap\)/);
  assert.equal(
    card.match(/orange-info-box--home/g)?.length,
    1
  );
  assert.match(homeCardStyles, /max-width: var\(--home-info-card-max-width\)/);
  assert.match(homeCardStyles, /padding: clamp\(1\.5rem, 5vw, 2\.75rem\)/);
  assert.match(baseCardStyles, /width: 100%/);
  assert.match(baseCardStyles, /max-width: 900px/);
  assert.match(styles, /--home-info-card-max-width: 660px/);
  assert.doesNotMatch(baseCardStyles, /660px|home-info-card-max-width/);
  assert.match(home, /id="info"\s+data-home-section="info"/);
  assert.match(
    home,
    /<Suspense fallback=\{null\}>\s*<HomeInfoBlocks\s+infoBlocksPromise=\{infoBlocksPromise\}/
  );
  assert.doesNotMatch(home, /<h3 className="orange-box-title">ABOUT/);
  assert.doesNotMatch(
    home,
    /<h3 className="orange-box-title">HOW IT WORKS/
  );
});

test("optional launch owns its segment and renders no empty wrapper", async () => {
  const home = await readRepoFile("app/page.tsx");
  const launchHelper = home.slice(
    home.indexOf("async function HomePrimaryCoinLaunch"),
    home.indexOf("export default function Home()")
  );

  assert.match(launchHelper, /return launch \? \(/);
  assert.match(launchHelper, /data-home-section="coin-launch"/);
  assert.match(launchHelper, /\) : null;/);
  assert.match(
    home,
    /<Suspense fallback=\{null\}>\s*<HomePrimaryCoinLaunch/
  );
  assert.equal(
    home.match(/data-home-section="coin-launch"/g)?.length,
    1
  );
});
