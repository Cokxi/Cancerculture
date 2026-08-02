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
  const infoStart = homeComponent.indexOf(
    "const infoBlocksPromise = getActiveHomepageInfoBlocks();"
  );
  const renderStart = homeComponent.indexOf("return (");

  assert.ok(transitionStart >= 0);
  assert.ok(launchStart >= 0);
  assert.ok(infoStart >= 0);
  assert.ok(renderStart > transitionStart);
  assert.ok(renderStart > launchStart);
  assert.ok(renderStart > infoStart);
  assert.doesNotMatch(
    homeComponent.slice(0, renderStart),
    /await\s+(processDueCycleTransitions|getPrimaryCoinLaunch|getActiveHomepageInfoBlocks)/
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

test("HUD, launch, and Info stream independently from the global account", async () => {
  const [home, layout] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile("app/layout.tsx"),
  ]);

  assert.match(
    home,
    /<Suspense fallback=\{<CycleHudFallback \/>\}>/
  );
  assert.match(home, /<HomeCycleHud/);
  assert.match(layout, /<GlobalAccount \/>/);
  assert.doesNotMatch(home, /<GlobalAccount \/>/);
  assert.match(
    home,
    /<Suspense fallback=\{null\}>\s*<HomePrimaryCoinLaunch/
  );
  assert.match(
    home,
    /<Suspense fallback=\{null\}>\s*<HomeInfoBlocks\s+infoBlocksPromise=\{infoBlocksPromise\}/
  );
  assert.match(
    home,
    /catch \{\s*console\.error\("\[COIN_LAUNCHES\] home launch loading failed"\);\s*return null;/
  );
});

test("public Homepage Info cache contains only active presentation fields", async () => {
  const [data, adminClient] = await Promise.all([
    readRepoFile("lib/homepageInfoBlocks/data.server.ts"),
    readRepoFile("lib/db/admin.ts"),
  ]);

  assert.match(data, /import "server-only"/);
  assert.match(data, /import \{ supabaseAdmin \} from "@\/lib\/db\/admin"/);
  assert.match(adminClient, /import "server-only"/);
  assert.match(adminClient, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(adminClient, /persistSession: false/);
  assert.match(data, /unstable_cache\(/);
  assert.match(data, /tags: \[HOMEPAGE_INFO_BLOCKS_CACHE_TAG\]/);
  assert.match(data, /\.eq\("is_active", true\)/);
  assert.match(data, /\.order\("display_order", \{ ascending: true \}\)/);
  assert.match(data, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(
    data,
    /const PUBLIC_SELECT =\s*"id, title, body, display_order, link_label, link_url"/
  );
  assert.doesNotMatch(
    data.slice(
      data.indexOf("const PUBLIC_SELECT"),
      data.indexOf("const ADMIN_SELECT")
    ),
    /seed_key|is_active|created_by|updated_by|created_at|updated_at/
  );
  assert.doesNotMatch(data, /createBrowserClient|NEXT_PUBLIC_SUPABASE_ANON_KEY/);
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
  const [home, cycleHud, globalAccount, accountRoute] = await Promise.all([
    readRepoFile("app/page.tsx"),
    readRepoFile("app/components/CycleHud.tsx"),
    readRepoFile("app/components/auth/GlobalAccount.tsx"),
    readRepoFile("app/api/auth/account/route.ts"),
  ]);

  assert.doesNotMatch(home, /getSessionState|requireSession|cookies\(/);
  assert.doesNotMatch(
    cycleHud,
    /getSessionState|requireSession|cookies\(/
  );
  assert.doesNotMatch(globalAccount, /getSessionState|supabaseAdmin/);
  assert.match(globalAccount, /fetch\("\/api\/auth\/account"/);
  assert.match(accountRoute, /await getSessionState\(\)/);
  assert.match(
    accountRoute,
    /const \[accountResult, teamAccess\] = await Promise\.all/
  );
});
