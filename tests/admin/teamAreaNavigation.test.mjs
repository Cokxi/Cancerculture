import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  meetsTeamAreaRequirement,
  resolveTeamAreaNavigation,
  TEAM_AREA_NAVIGATION,
} from "../../lib/admin/teamAreaNavigation.ts";
import {
  findActiveTeamAreaItem,
  getTeamAreaBreadcrumbs,
  isTeamAreaPathActive,
} from "../../lib/admin/teamAreaNavigationState.ts";
import { AuthError } from "../../lib/auth/AuthError.ts";
import { getTeamPageAccessRedirect } from "../../lib/auth/pageAccessDecision.ts";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");

function context({
  isAdmin = false,
  capabilities = [],
  role = isAdmin ? "admin" : "moderator",
} = {}) {
  return {
    discord_user_id: "123",
    role,
    isAdmin,
    resolvedCapabilities: capabilities,
  };
}

test("the central definition exposes implemented Admin items and filters unavailable categories", () => {
  const resolved = resolveTeamAreaNavigation(context());
  assert.deepEqual(resolved, []);

  const team = TEAM_AREA_NAVIGATION.find(
    (category) => category.id === "team"
  );
  const addMember = team.items.find(
    (entry) => entry.id === "add-team-member"
  );
  assert.equal(addMember?.href, "/admin/team/members/add");
  assert.equal(addMember?.implemented, true);
  assert.deepEqual(addMember?.requirement, { type: "admin" });
  assert.equal(
    JSON.stringify(resolveTeamAreaNavigation(context({ isAdmin: true })))
      .includes("add-team-member"),
    true
  );
});

test("non-admin navigation exposes only explicitly granted routes", () => {
  const resolved = resolveTeamAreaNavigation(
    context({
      capabilities: ["submissions.submission_phase.reinstate"],
    })
  );

  assert.deepEqual(
    resolved.map((category) => category.id),
    ["moderation"]
  );
  assert.deepEqual(
    resolved[0].items.map((entry) => entry.id),
    ["live-moderation", "disqualified-submissions"]
  );
  assert.equal(
    JSON.stringify(resolved).includes("legal-review"),
    false
  );
});

test("the user directory needs its existing capability grant", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["users.directory.basic.view"] })
  );

  assert.equal(JSON.stringify(withoutGrant).includes("user-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("user-logs"), true);
});

test("admin remains a hard role requirement rather than a capability grant", () => {
  assert.equal(
    meetsTeamAreaRequirement(
      context({
        role: "moderator",
        capabilities: [
          "submissions.submission_phase.disqualify",
          "users.flag",
          "users.directory.basic.view",
        ],
      }),
      { type: "admin" }
    ),
    false
  );
  assert.equal(
    meetsTeamAreaRequirement(context({ isAdmin: true }), {
      type: "admin",
    }),
    true
  );
});

test("any-capability requirements resolve without static fallback", () => {
  const requirement = {
    type: "anyCapability",
    capabilities: ["users.flag", "users.directory.basic.view"],
  };
  assert.equal(
    meetsTeamAreaRequirement(
      context({ capabilities: ["users.flag"] }),
      requirement
    ),
    true
  );
  assert.equal(
    meetsTeamAreaRequirement(context(), requirement),
    false
  );
});

test("active state and breadcrumbs resolve categorized and nested paths", () => {
  const navigation = resolveTeamAreaNavigation(
    context({ isAdmin: true })
  );

  assert.equal(isTeamAreaPathActive("/admin/cycles", "/admin/cycles"), true);
  assert.equal(
    isTeamAreaPathActive("/admin/cycles/history", "/admin/cycles"),
    true
  );
  assert.equal(
    findActiveTeamAreaItem(navigation, "/admin/logs/cycles")?.entry.id,
    "cycle-logs"
  );
  assert.deepEqual(
    getTeamAreaBreadcrumbs(navigation, "/admin/logs/cycles"),
    ["Team Area", "Cycles", "Cycle Logs"]
  );
  assert.deepEqual(
    getTeamAreaBreadcrumbs(
      navigation,
      "/admin/moderation/legal-review"
    ),
    ["Team Area", "Moderation", "Legal Review"]
  );
  assert.deepEqual(
    getTeamAreaBreadcrumbs(
      navigation,
      "/admin/team/authorization-history"
    ),
    ["Team Area", "Team", "Authorization History"]
  );
  assert.equal(
    findActiveTeamAreaItem(
      navigation,
      "/admin/team/members/add"
    )?.entry.id,
    "add-team-member"
  );
  assert.equal(
    navigation
      .flatMap((category) => category.items)
      .filter(
        (entry) =>
          entry.id ===
          findActiveTeamAreaItem(
            navigation,
            "/admin/team/members/add"
          )?.entry.id
      ).length,
    1
  );
  assert.deepEqual(
    getTeamAreaBreadcrumbs(
      navigation,
      "/admin/team/members/add"
    ),
    ["Team Area", "Team", "Add Team Member"]
  );
});

test("the landing page is real and no longer redirects to logs", async () => {
  const page = await source("app/admin/page.tsx");
  assert.match(page, /<h1[^>]*>Team Area<\/h1>/);
  assert.doesNotMatch(page, /redirect\(["']\/admin\/logs["']\)/);
  assert.match(page, /getResolvedTeamAreaNavigation/);
});

test("desktop and mobile render the same resolved navigation", async () => {
  const shell = await source("app/admin/TeamAreaShell.tsx");
  assert.equal(
    shell.match(/<NavigationGroups/g)?.length,
    2,
    "desktop and mobile must both use NavigationGroups"
  );
  assert.match(shell, /href="\/admin"/);
  assert.match(shell, /href="\/"/);
  assert.match(shell, /findActiveTeamAreaItem\(navigation, pathname\)/);
  assert.match(shell, /activeItem\?\.entry\.id === entry\.id/);
  assert.match(shell, /aria-current=\{active \? "page"/);
});

test("401/403 and 503 retain distinct controlled destinations", () => {
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(401, "No session")),
    "/403"
  );
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(403, "Forbidden")),
    "/403"
  );
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(503, "Unavailable")),
    "/503"
  );
});

test("the general shell does not load legal review metadata", async () => {
  const layout = await source("app/admin/layout.tsx");
  const legalPage = await source(
    "app/admin/moderation/legal-review/page.tsx"
  );

  assert.doesNotMatch(layout, /legalReviewCount|public_visibility_status/);
  assert.match(
    legalPage,
    /requireAdminPage\("\/admin\/moderation\/legal-review"\)/
  );
  assert.ok(
    legalPage.indexOf("requireAdminPage") <
      legalPage.indexOf('.from("submissions")')
  );
});

test("phase-aware direct page guards remain in place", async () => {
  const [moderation, disqualified, users, legal] = await Promise.all([
    source("app/admin/moderation/submissions/page.tsx"),
    source("app/admin/moderation/disqualified/page.tsx"),
    source("app/admin/users/page.tsx"),
    source("app/admin/moderation/legal-review/page.tsx"),
  ]);

  assert.match(moderation, /requireLiveModerationPage/);
  assert.match(disqualified, /requireDisqualifiedSubmissionsPage/);
  assert.match(
    users,
    /requireDynamicTeamCapability\(\s*"users\.directory\.basic\.view"/
  );
  assert.match(legal, /requireAdminPage/);
});
