import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = async (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("both canonical Team authorization paths require the same central grant", async () => {
  const [dynamic, legacy] = await Promise.all([
    source("lib/auth/teamAuthorization.ts"),
    source("lib/auth/guards.ts"),
  ]);
  assert.match(dynamic, /await requireTeamAreaAccess\(session\)/u);
  assert.match(legacy, /await requireTeamAreaAccess\(session\)/u);
  assert.ok(dynamic.indexOf("readTeamAuthorizationContextForDiscordUserId") < dynamic.lastIndexOf("requireTeamAreaAccess"));
  assert.ok(legacy.indexOf("getTeamMemberForDiscordUserId") < legacy.lastIndexOf("requireTeamAreaAccess"));
});

test("unlock response rotates session and writes only HttpOnly scoped cookies", async () => {
  const route = await source("app/api/auth/team-access/route.ts");
  assert.match(route, /response[.]cookies[.]set\("session_id", grant[.]sessionId/u);
  assert.match(route, /response[.]cookies[.]set\(TEAM_ACCESS_COOKIE, grant[.]token/u);
  assert.match(route, /httpOnly: true/u);
  assert.match(route, /secure: process[.]env[.]NODE_ENV === "production"/u);
  assert.match(route, /sameSite: "lax"/u);
  assert.match(route, /maxAge: TEAM_ACCESS_MAX_AGE_SECONDS/u);
  assert.match(route, /origin !== new URL\(request[.]url\)[.]origin/u);
  assert.doesNotMatch(route, /discord_user_id.*cookies[.]set|role.*cookies[.]set|user-agent.*cookies[.]set/iu);
});

test("logout and every new Discord login remove stale Team cookies", async () => {
  const [logout, callback] = await Promise.all([
    source("app/api/auth/logout/route.ts"),
    source("app/api/auth/discord/callback/route.ts"),
  ]);
  assert.match(logout, /expireCookie\(response, "team_access"\)/u);
  assert.match(callback, /expireCookie\(successResponse, "team_access"\)/u);
  assert.match(callback, /expireCookie\(response, "team_access"\)/u);
});

test("Team prompt promises one 12-hour grant instead of per-action verification", async () => {
  const [page, form] = await Promise.all([
    source("app/team-access/page.tsx"),
    source("app/team-access/TeamAccessForm.tsx"),
  ]);
  assert.match(page, /for 12 hours in this website session/u);
  assert.match(page, /does not store raw device, browser, or network information/u);
  assert.match(form, /autoComplete="one-time-code"/u);
  assert.doesNotMatch(`${page}\n${form}`, /every action|per action/iu);
});
