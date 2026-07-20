import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAccountNavigationState } from "../../lib/auth/accountNavigation.ts";
import {
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
      "about",
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
  assert.match(menu, /cursor-pointer/);
});

test("home menu and shared Back button retain accessible pointer contracts", async () => {
  const [homeMenu, backButton] = await Promise.all([
    readRepoFile("app/components/navigation/HomeMenu.tsx"),
    readRepoFile("app/components/ui/BackButton.tsx"),
  ]);

  assert.match(homeMenu, /className="fixed left-3 top-\[74px\]/);
  assert.match(homeMenu, /supportsHoverInteraction\(\)/);
  assert.match(homeMenu, /aria-haspopup="menu"/);
  assert.match(homeMenu, /event\.key === "Escape"/);
  assert.match(homeMenu, /document\.addEventListener\("pointerdown"/);
  assert.match(homeMenu, /cursor-pointer/);
  assert.match(backButton, /border-orange-500\/45/);
  assert.match(backButton, /cursor-pointer/);
});
