import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAccountNavigationState } from "../../lib/auth/accountNavigation.ts";
import {
  HOME_NAVIGATION_ITEMS,
  getHomeDesktopNavigationItems,
  getHomeMenuItems,
} from "../../lib/navigation/homeNavigation.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const itemIds = (state) => state.items.map((item) => item.id);

test("authenticated users receive profile and safe server logout only", () => {
  const state = createAccountNavigationState({
    sessionStatus: "authenticated",
  });

  assert.equal(state.kind, "authenticated");
  assert.deepEqual(itemIds(state), ["profile", "logout"]);
  assert.equal(
    state.items.find((item) => item.id === "profile")?.href,
    "/my-profile"
  );
});

test("moderators and admins receive only their intended navigation", () => {
  const moderator = createAccountNavigationState({
    sessionStatus: "authenticated",
    teamRole: "mod",
  });
  const admin = createAccountNavigationState({
    sessionStatus: "authenticated",
    teamRole: "admin",
  });

  assert.deepEqual(itemIds(moderator), ["profile", "moderation", "logout"]);
  assert.deepEqual(itemIds(admin), [
    "profile",
    "moderation",
    "admin",
    "logout",
  ]);
  assert.equal(
    moderator.items.find((item) => item.id === "moderation")?.href,
    "/admin/moderation/submissions"
  );
  assert.equal(
    admin.items.find((item) => item.id === "admin")?.href,
    "/admin"
  );
});

test("anonymous and dependency states never disclose team navigation", () => {
  for (const sessionStatus of ["anonymous", "dependency_unavailable"]) {
    const state = createAccountNavigationState({
      sessionStatus,
      teamRole: "admin",
    });
    assert.deepEqual(state.items, []);
  }

  const degraded = createAccountNavigationState({
    sessionStatus: "authenticated",
    teamRole: "admin",
    teamAccessUnavailable: true,
  });
  assert.equal(degraded.kind, "authenticated");
  assert.equal(degraded.teamAccessUnavailable, true);
  assert.deepEqual(itemIds(degraded), ["profile", "logout"]);
});

test("desktop and mobile home navigation expose the intended links", () => {
  assert.deepEqual(
    getHomeMenuItems({ mobile: false }).map((item) => item.id),
    ["cycle-history"]
  );
  assert.deepEqual(
    getHomeMenuItems({ mobile: true }).map((item) => item.id),
    [
      "info",
      "upload",
      "submissions",
      "faq",
      "rules",
      "wall-fame",
      "wall-shame",
      "cycle-history",
    ]
  );
  assert.equal(
    getHomeDesktopNavigationItems().some(
      (item) => item.id === "cycle-history"
    ),
    false
  );
  assert.deepEqual(HOME_NAVIGATION_ITEMS[0], {
    id: "info",
    label: "Info",
    href: "#info",
    showInDesktopBar: true,
  });
});

test("menus are home-only and duplicate floating profile links stay removed", async () => {
  const [layout, home] = await Promise.all([
    readRepoFile("app/layout.tsx"),
    readRepoFile("app/page.tsx"),
  ]);

  assert.doesNotMatch(layout, /GlobalAccount|HomeMenu|GlobalHeader/);
  assert.match(home, /<HomeMenu \/>/);
  assert.match(home, /<GlobalAccount \/>/);
  assert.match(home, /aria-label="Primary navigation"/);
  assert.doesNotMatch(home, />\s*My Profile\s*</);
});

test("home Info navigation keeps stable pointer, hover, focus, and active states", async () => {
  const home = await readRepoFile("app/page.tsx");

  assert.match(home, /item\.id === "info"/);
  assert.match(home, /cursor-pointer/);
  assert.match(home, /hover:text-orange-200/);
  assert.match(home, /focus-visible:ring-2/);
  assert.match(home, /active:text-orange-100/);
  assert.doesNotMatch(home, /item\.id === "info"[\s\S]*hover:scale/);
});

test("account menu preserves the existing POST logout flow", async () => {
  const menu = await readRepoFile("app/components/auth/AccountMenu.tsx");

  assert.match(menu, /action="\/api\/auth\/logout\?returnTo=\/"/);
  assert.match(menu, /method="post"/);
  assert.doesNotMatch(menu, /document\.cookie|localStorage/);
});

test("account menu exposes keyboard, focus, and dismissal contracts", async () => {
  const menu = await readRepoFile("app/components/auth/AccountMenu.tsx");

  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /role="menu"/);
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, /event\.key === "Escape"/);
  assert.match(menu, /event\.key !== "ArrowDown"/);
  assert.match(menu, /document\.addEventListener\("pointerdown"/);
  assert.match(menu, /triggerRef\.current\?\.focus\(\)/);
  assert.match(menu, /onClick=\{\(\) => closeMenu\(\)\}/);
  assert.match(menu, /supportsHoverInteraction\(\)/);
  assert.match(menu, /onMouseEnter/);
  assert.match(menu, /onMouseLeave/);
  assert.match(menu, /navigationTriggerBaseClassName/);
});

test("global navigation triggers share stable pill interaction styles", async () => {
  const [homeMenu, accountMenu, backButton, globalAccount, styles] =
    await Promise.all([
      readRepoFile("app/components/navigation/HomeMenu.tsx"),
      readRepoFile("app/components/auth/AccountMenu.tsx"),
      readRepoFile("app/components/ui/BackButton.tsx"),
      readRepoFile("app/components/auth/GlobalAccount.tsx"),
      readRepoFile(
        "app/components/navigation/navigationButtonStyles.ts"
      ),
    ]);

  assert.match(homeMenu, /className="fixed left-3 top-\[74px\]/);
  assert.match(homeMenu, /supportsHoverInteraction\(\)/);
  assert.match(homeMenu, /aria-haspopup="menu"/);
  assert.match(homeMenu, /event\.key === "Escape"/);
  assert.match(homeMenu, /document\.addEventListener\("pointerdown"/);
  assert.match(homeMenu, /navigationTextTriggerClassName/);
  assert.match(accountMenu, /navigationTriggerBaseClassName/);
  assert.match(globalAccount, /navigationTextTriggerClassName/);
  assert.match(backButton, /navigationTextTriggerClassName/);
  assert.match(styles, /rounded-full/);
  assert.match(styles, /border-2 border-orange-500\/70/);
  assert.match(styles, /cursor-pointer/);
  assert.match(styles, /focus-visible:ring-2/);
  assert.match(styles, /active:bg-orange-500\/20/);
  assert.doesNotMatch(styles, /hover:border|hover:scale|animate-/);
});

test("account trigger is explicit on mobile and safely ellipses desktop names", async () => {
  const accountMenu = await readRepoFile(
    "app/components/auth/AccountMenu.tsx"
  );

  assert.match(accountMenu, /className="text-sm sm:hidden">Profile</);
  assert.match(
    accountMenu,
    /hidden min-w-0 max-w-\[8rem\] truncate text-sm sm:inline/
  );
  assert.match(accountMenu, /title=\{displayName\}/);
  assert.match(
    accountMenu,
    /className="break-words px-3 pb-2 pt-1 text-xs text-white\/55"/
  );
  assert.doesNotMatch(accountMenu, /displayName\.(slice|substring)/);
});

test("homepage links use Home semantics instead of back navigation", async () => {
  const files = await Promise.all(
    [
      "app/components/ui/BackButton.tsx",
      "app/components/ui/OrangePlaceholderPage.tsx",
      "app/cycle-history/page.tsx",
      "app/my-profile/page.tsx",
      "app/profile/[publicProfileId]/page.tsx",
    ].map(readRepoFile)
  );

  for (const source of files) {
    assert.doesNotMatch(source, /label="Back"|label = "Back"|&larr;/);
  }
  assert.match(files[0], /label = "Home"/);
});
