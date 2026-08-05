import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("the real Homepage Info page and every mutation require homepage_content.manage", async () => {
  const [page, actions] = await Promise.all([
    readRepoFile("app/admin/homepage-info-blocks/page.tsx"),
    readRepoFile("app/admin/homepage-info-blocks/actions.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\(\s*"homepage_content\.manage",\s*"\/admin\/homepage-info-blocks"\s*\)/u
  );
  assert.equal(
    actions.match(
      /requireDynamicTeamCapability\(\s*"homepage_content\.manage"\s*\)/gu
    )?.length,
    4
  );
  assert.doesNotMatch(`${page}\n${actions}`, /requireAdmin(?:Page)?\(/u);
  assert.doesNotMatch(actions, /formData\.get\("role"\)/);
  assert.match(actions, /created_by: authorization\.discord_user_id/);
  assert.match(actions, /updated_by: authorization\.discord_user_id/);
  assert.match(
    actions,
    /actorType: isAdmin \? "admin" : "moderator"/u
  );
  assert.match(
    actions,
    /authorization_capability: "homepage_content\.manage"/u
  );
  assert.match(actions, /authorization_role: actorRole/u);
});

test("Admin actions implement Create, Edit, Toggle, and hard Delete", async () => {
  const actions = await readRepoFile(
    "app/admin/homepage-info-blocks/actions.ts"
  );

  assert.match(actions, /createHomepageInfoBlockAction/);
  assert.match(actions, /\.insert\(\{/);
  assert.match(actions, /updateHomepageInfoBlockAction/);
  assert.match(actions, /\.update\(\{/);
  assert.match(actions, /setHomepageInfoBlockActiveAction/);
  assert.match(actions, /requestedValue !== "true"/);
  assert.match(actions, /deleteHomepageInfoBlockAction/);
  assert.match(actions, /\.delete\(\)/);
  assert.equal(
    actions.match(/invalidateHomepageInfoBlocks\(\);/g)?.length,
    4
  );
  assert.match(actions, /logAdminAction\(\{/);
  assert.doesNotMatch(actions, /meta:[\s\S]*?\bbody\b/);
  assert.doesNotMatch(actions, /error\?\.message|error\.message/);
});

test("cache invalidation occurs only after successful mutations", async () => {
  const actions = await readRepoFile(
    "app/admin/homepage-info-blocks/actions.ts"
  );

  for (const actionName of [
    "createHomepageInfoBlockAction",
    "updateHomepageInfoBlockAction",
    "setHomepageInfoBlockActiveAction",
    "deleteHomepageInfoBlockAction",
  ]) {
    const start = actions.indexOf(`function ${actionName}`);
    const next = actions.indexOf("\nexport async function ", start + 1);
    const body = actions.slice(start, next < 0 ? undefined : next);
    const failure = body.indexOf("if (error || !data)");
    const invalidation = body.indexOf("invalidateHomepageInfoBlocks();");

    assert.ok(failure >= 0, `${actionName} checks mutation failure`);
    assert.ok(
      invalidation > failure,
      `${actionName} invalidates only after success`
    );
  }

  assert.match(actions, /updateTag\(HOMEPAGE_INFO_BLOCKS_CACHE_TAG\)/);
  assert.match(actions, /revalidatePath\("\/"\)/);
  assert.match(actions, /revalidatePath\(ADMIN_PATH\)/);
});

test("Admin list is fresh, editable when inactive, and previews active order", async () => {
  const [page, data, card] = await Promise.all([
    readRepoFile("app/admin/homepage-info-blocks/page.tsx"),
    readRepoFile("lib/homepageInfoBlocks/data.server.ts"),
    readRepoFile(
      "app/components/homepageInfoBlocks/HomepageInfoBlockCard.tsx"
    ),
  ]);

  const adminHelper = data.slice(
    data.indexOf("export async function getHomepageInfoBlocksForAdmin")
  );

  assert.doesNotMatch(adminHelper, /unstable_cache/);
  assert.match(adminHelper, /\.order\("display_order"/);
  assert.match(adminHelper, /\.order\("id"/);
  assert.match(page, /blocks\.map\(\(block\) =>/);
  assert.match(page, /<InfoBlockFields block=\{block\} \/>/);
  assert.match(page, /\{block\.displayOrder\} — Edit/);
  assert.match(page, /activeBlocks = blocks\.filter\(\(block\) => block\.isActive\)/);
  assert.match(page, /<HomepageInfoBlockCard key=\{block\.id\} block=\{block\} \/>/);
  assert.match(
    page,
    /No active Homepage Info Boxes are currently published/
  );
  assert.match(card, /whitespace-pre-wrap/);
  assert.doesNotMatch(card, /dangerouslySetInnerHTML/);
});

test("hard Delete requires explicit confirmation and interactive controls are visible", async () => {
  const [button, page, navigation] = await Promise.all([
    readRepoFile(
      "app/admin/homepage-info-blocks/DeleteHomepageInfoBlockButton.tsx"
    ),
    readRepoFile("app/admin/homepage-info-blocks/page.tsx"),
    readRepoFile("lib/admin/teamAreaNavigation.ts"),
  ]);

  assert.match(button, /window\.confirm\(/);
  assert.match(button, /Delete this Info Box permanently/);
  assert.match(button, /cannot be recovered/);
  assert.match(button, /event\.preventDefault\(\)/);
  for (const source of [button, page]) {
    assert.match(source, /cursor-pointer/);
    assert.match(source, /hover:/);
    assert.match(source, /focus-visible:ring-2/);
    assert.match(source, /active:/);
  }
  assert.match(navigation, /href: "\/admin\/homepage-info-blocks"/);
});
