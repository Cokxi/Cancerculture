import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAccountNavigationState } from "../../lib/auth/accountNavigation.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function accountMenuBranches(source) {
  const logoutStart = source.indexOf('if (item.kind === "logout")');
  const linkElement = source.indexOf("<Link", logoutStart);
  const linkStart = source.lastIndexOf("return (", linkElement);

  assert.ok(logoutStart > -1, "logout branch must exist");
  assert.ok(linkStart > logoutStart, "normal link branch must exist");

  return {
    logout: source.slice(logoutStart, linkStart),
    link: source.slice(linkStart, source.indexOf("};", linkStart)),
  };
}

test("authenticated and membership-pending users retain server logout", () => {
  const authenticated = createAccountNavigationState({
    sessionStatus: "authenticated",
  });
  const membershipPending = createAccountNavigationState({
    sessionStatus: "authenticated",
    teamAccessUnavailable: true,
  });

  assert.equal(authenticated.items.at(-1)?.kind, "logout");
  assert.equal(membershipPending.items.at(-1)?.kind, "logout");
});

test("logout submits the existing POST route without unmounting its form", async () => {
  const menu = await readRepoFile("app/components/auth/AccountMenu.tsx");
  const { logout } = accountMenuBranches(menu);

  assert.match(logout, /action="\/api\/auth\/logout\?returnTo=\/"/);
  assert.match(logout, /method="post"/);
  assert.match(logout, /type="submit"/);
  assert.doesNotMatch(logout, /onClick=|preventDefault/);
  assert.doesNotMatch(logout, /document\.cookie|localStorage/);
});

test("normal account navigation closes the menu without submitting logout", async () => {
  const menu = await readRepoFile("app/components/auth/AccountMenu.tsx");
  const { link } = accountMenuBranches(menu);

  assert.match(link, /<Link/);
  assert.match(link, /onClick=\{\(\) => closeMenu\(\)\}/);
  assert.doesNotMatch(link, /api\/auth\/logout|type="submit"/);
});

test("logout revokes the server session before expiring auth cookies", async () => {
  const route = await readRepoFile("app/api/auth/logout/route.ts");
  const revocation = route.indexOf('.from("sessions")');
  const sessionExpiry = route.indexOf(
    'expireCookie(response, "session_id")'
  );

  assert.ok(revocation > -1);
  assert.match(route.slice(revocation, sessionExpiry), /revoked_at/);
  assert.ok(sessionExpiry > revocation);
  assert.match(route, /expireCookie\(response, "discord_user_id"\)/);
  assert.match(route, /maxAge: 0/);
});

test("logout redirects to the sanitized public route and refreshes auth UI", async () => {
  const route = await readRepoFile("app/api/auth/logout/route.ts");

  assert.match(route, /sanitizeInternalReturnPath/);
  assert.match(route, /NextResponse\.redirect\([\s\S]*303/);
  assert.match(route, /Cache-Control", "no-store"/);
});

test("participation and Discord membership cannot guard logout", async () => {
  const route = await readRepoFile("app/api/auth/logout/route.ts");

  assert.doesNotMatch(
    route,
    /requireSession|requireParticipation|discordMembership|membership_pending/
  );
  assert.doesNotMatch(route, /requireAdmin|requireModerator|guards/);
});

test("Discord and website bans retain an unguarded server logout", async () => {
  const [globalAccount, sessionState] = await Promise.all([
    readRepoFile("app/components/auth/GlobalAccount.tsx"),
    readRepoFile("lib/auth/sessionState.ts"),
  ]);
  const restrictedBranch = globalAccount.slice(
    globalAccount.indexOf('sessionState.status === "restricted"'),
    globalAccount.indexOf("const discordUserId")
  );

  assert.match(sessionState, /code === "DISCORD_BANNED"/);
  assert.match(sessionState, /code === "WEBSITE_BANNED"/);
  assert.match(restrictedBranch, /action="\/api\/auth\/logout\?returnTo=\/"/);
  assert.match(restrictedBranch, /method="post"/);
});
