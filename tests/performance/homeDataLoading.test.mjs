import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("independent home data starts before the page shell renders", async () => {
  const home = await readRepoFile("app/page.tsx");
  const homeComponent = home.slice(
    home.indexOf("export default function Home()")
  );
  const transitionStart = homeComponent.indexOf(
    "const transitionPromise = processDueCycleTransitions();"
  );
  const launchStart = homeComponent.indexOf(
    "const launchPromise = getPrimaryCoinLaunch();"
  );
  const renderStart = homeComponent.indexOf("return (");

  assert.ok(transitionStart >= 0);
  assert.ok(launchStart >= 0);
  assert.ok(renderStart > transitionStart);
  assert.ok(renderStart > launchStart);
  assert.doesNotMatch(
    homeComponent.slice(0, renderStart),
    /await\s+(processDueCycleTransitions|getPrimaryCoinLaunch)/
  );
  assert.equal(
    home.match(/processDueCycleTransitions\(\)/g)?.length,
    1
  );
  assert.match(
    home,
    /await transitionPromise;\s*return <CycleHud \/>;/
  );
});

test("HUD, account, and optional launch stream in separate boundaries", async () => {
  const home = await readRepoFile("app/page.tsx");

  assert.match(
    home,
    /<Suspense fallback=\{<CycleHudFallback \/>\}>/
  );
  assert.match(home, /<HomeCycleHud/);
  assert.match(home, /<Suspense\s+fallback=\{/);
  assert.match(home, /<GlobalAccount \/>/);
  assert.match(
    home,
    /<Suspense fallback=\{null\}>\s*<HomePrimaryCoinLaunch/
  );
  assert.match(
    home,
    /catch \{\s*console\.error\("\[COIN_LAUNCHES\] home launch loading failed"\);\s*return null;/
  );
});

test("CycleHud overlaps independent reads and preserves dependent sponsor loading", async () => {
  const cycleHud = await readRepoFile(
    "app/components/CycleHud.tsx"
  );
  const cycleStart = cycleHud.indexOf(
    "const cyclePromise = getPreferredCycle();"
  );
  const configStart = cycleHud.indexOf(
    "const nextCycleThemePromise = supabaseAdmin"
  );
  const cycleAwait = cycleHud.indexOf(
    "const cycle = await cyclePromise;"
  );

  assert.ok(cycleStart >= 0);
  assert.ok(configStart > cycleStart);
  assert.ok(cycleAwait > configStart);
  assert.match(
    cycleHud,
    /const fallbackSponsorMetaPromise =\s*cycle && shouldUseSponsorFallback\s*\? getCycleSponsoredMeta\(cycle\.id\)/
  );
  assert.match(
    cycleHud,
    /await Promise\.all\(\[\s*fallbackSponsorMetaPromise,\s*nextCycleThemePromise/
  );
  assert.doesNotMatch(cycleHud, /HOME_PERF|performance\.now/);
  assert.doesNotMatch(
    cycleHud,
    /results_published_at|archived_at|paused_from_status|phase_pause_reason/
  );
});

test("primary launch transfers at most one row", async () => {
  const launches = await readRepoFile(
    "lib/coinLaunches/getActiveCoinLaunches.ts"
  );
  const primaryHelper = launches.slice(
    launches.indexOf(
      "export async function getPrimaryCoinLaunch()"
    )
  );

  assert.match(primaryHelper, /\.limit\(1\)/);
  assert.match(primaryHelper, /\.maybeSingle\(\)/);
  assert.doesNotMatch(
    primaryHelper,
    /await getActiveCoinLaunches\(\)/
  );
});

test("public hero and user account data stay isolated", async () => {
  const [home, cycleHud, globalAccount] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile("app/components/CycleHud.tsx"),
    readRepoFile("app/components/auth/GlobalAccount.tsx"),
  ]);

  assert.doesNotMatch(home, /getSessionState|requireSession|cookies\(/);
  assert.doesNotMatch(
    cycleHud,
    /getSessionState|requireSession|cookies\(/
  );
  assert.match(globalAccount, /await getSessionState\(\)/);
  assert.match(
    globalAccount,
    /const \[accountResult, teamAccess\] = await Promise\.all/
  );
});
