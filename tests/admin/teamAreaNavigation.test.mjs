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

test("user disqualification history needs only its exact read capability", () => {
  const historyOnly = JSON.stringify(
    resolveTeamAreaNavigation(
      context({
        capabilities: ["users.disqualified_submissions.view"],
      })
    )
  );
  const directoryOnly = JSON.stringify(
    resolveTeamAreaNavigation(
      context({ capabilities: ["users.directory.full.view"] })
    )
  );

  assert.equal(
    historyOnly.includes('"id":"user-disqualification-history"'),
    true
  );
  assert.equal(historyOnly.includes('"id":"user-logs"'), false);
  assert.equal(historyOnly.includes("moderation-logs"), false);
  assert.equal(
    directoryOnly.includes("user-disqualification-history"),
    false
  );
});

test("upload logs navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["logs.uploads.view"] })
  );

  assert.equal(JSON.stringify(withoutGrant).includes("upload-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("upload-logs"), true);
  assert.equal(JSON.stringify(withGrant).includes("avatar-upload-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("vote-logs"), false);
});

test("avatar upload logs navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["logs.avatar_uploads.view"] })
  );

  assert.equal(
    JSON.stringify(withoutGrant).includes("avatar-upload-logs"),
    false
  );
  assert.equal(
    JSON.stringify(withGrant).includes("avatar-upload-logs"),
    true
  );
  assert.equal(JSON.stringify(withGrant).includes('"id":"upload-logs"'), false);
  assert.equal(JSON.stringify(withGrant).includes("vote-logs"), false);
});

test("vote logs navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["logs.votes.view"] })
  );

  assert.equal(JSON.stringify(withoutGrant).includes("vote-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("vote-logs"), true);
  assert.equal(
    JSON.stringify(withGrant).includes("avatar-upload-logs"),
    false
  );
  assert.equal(
    JSON.stringify(withGrant).includes('"id":"upload-logs"'),
    false
  );
});

test("vote refunds and refund history require separate exact capabilities", () => {
  const refundOnly = JSON.stringify(
    resolveTeamAreaNavigation(
      context({ capabilities: ["votes.refund_disqualified"] })
    )
  );
  const historyOnly = JSON.stringify(
    resolveTeamAreaNavigation(
      context({ capabilities: ["logs.vote_refunds.view"] })
    )
  );

  assert.equal(refundOnly.includes('"id":"vote-refunds"'), true);
  assert.equal(refundOnly.includes("vote-refund-history"), false);
  assert.equal(historyOnly.includes("vote-refund-history"), true);
  assert.equal(historyOnly.includes('"id":"vote-refunds"'), false);
  assert.equal(historyOnly.includes("vote-logs"), false);
});

test("submission moderation logs navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["logs.submission_moderation.view"] })
  );

  assert.equal(
    JSON.stringify(withoutGrant).includes("moderation-logs"),
    false
  );
  assert.equal(
    JSON.stringify(withGrant).includes("moderation-logs"),
    true
  );
  assert.equal(JSON.stringify(withGrant).includes("vote-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("social-logs"), false);
});

test("Submission Report queues and logs each need their exact capability", () => {
  const live = JSON.stringify(resolveTeamAreaNavigation(context({
    capabilities: ["submissions.reports.live.view"],
  })));
  const finalized = JSON.stringify(resolveTeamAreaNavigation(context({
    capabilities: ["submissions.reports.finalized.view"],
  })));
  const reporters = JSON.stringify(resolveTeamAreaNavigation(context({
    capabilities: ["logs.submission_reporters.view"],
  })));
  const workflow = JSON.stringify(resolveTeamAreaNavigation(context({
    capabilities: ["logs.submission_report_moderation.view"],
  })));

  assert.equal(live.includes("live-submission-reports"), true);
  assert.equal(live.includes("finalized-submission-reports"), false);
  assert.equal(finalized.includes("finalized-submission-reports"), true);
  assert.equal(finalized.includes("live-submission-reports"), false);
  assert.equal(reporters.includes("submission-reporter-history"), true);
  assert.equal(reporters.includes("submission-report-workflow-history"), false);
  assert.equal(workflow.includes("submission-report-workflow-history"), true);
  assert.equal(workflow.includes("submission-reporter-history"), false);
});

test("authorization history navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["logs.team_authorization.view"] })
  );

  assert.equal(
    JSON.stringify(withoutGrant).includes("authorization-history"),
    false
  );
  assert.equal(
    JSON.stringify(withGrant).includes("authorization-history"),
    true
  );
  assert.equal(JSON.stringify(withGrant).includes("team-members"), false);
  assert.equal(JSON.stringify(withGrant).includes("roles-permissions"), false);
});

test("Cycle Logs navigation needs only its exact read capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["cycles.logs.view"] })
  );

  assert.equal(JSON.stringify(withoutGrant).includes("cycle-logs"), false);
  assert.equal(JSON.stringify(withGrant).includes("cycle-logs"), true);
  assert.equal(JSON.stringify(withGrant).includes("cycle-management"), false);
  assert.equal(JSON.stringify(withGrant).includes("winner-payouts"), false);
});

test("Cycle Management navigation needs only cycles.manage", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["cycles.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(JSON.stringify(withoutGrant).includes("cycle-management"), false);
  assert.equal(rendered.includes("cycle-management"), true);
  assert.equal(rendered.includes("cycle-end-moderation"), true);
  assert.equal(rendered.includes("cycle-vote-observations"), false);
  assert.equal(rendered.includes("cycle-logs"), false);
  assert.equal(rendered.includes("winner-payouts"), false);
});

test("Cycle Vote Observations remains Owner-only", () => {
  const delegated = resolveTeamAreaNavigation(
    context({
      capabilities: ["cycles.manage", "logs.votes.view"],
    })
  );
  const owner = resolveTeamAreaNavigation(context({ isAdmin: true }));

  assert.equal(
    JSON.stringify(delegated).includes("cycle-vote-observations"),
    false
  );
  assert.equal(
    JSON.stringify(owner).includes("cycle-vote-observations"),
    true
  );
});

test("Rules Content navigation needs only rules.manage", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["rules.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(JSON.stringify(withoutGrant).includes("update-rules"), false);
  assert.equal(rendered.includes("update-rules"), true);
  assert.equal(rendered.includes("homepage-info-boxes"), false);
  assert.equal(rendered.includes("update-faq"), false);
  assert.equal(rendered.includes("coin-launch-links"), false);
  assert.equal(rendered.includes("cycle-management"), false);
});

test("FAQ Content navigation needs only faq.manage", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["faq.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(JSON.stringify(withoutGrant).includes("update-faq"), false);
  assert.equal(rendered.includes("update-faq"), true);
  assert.equal(rendered.includes("update-rules"), false);
  assert.equal(rendered.includes("homepage-info-boxes"), false);
  assert.equal(rendered.includes("coin-launch-links"), false);
  assert.equal(rendered.includes("cycle-management"), false);
});

test("Homepage Info navigation needs only homepage_content.manage", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["homepage_content.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(
    JSON.stringify(withoutGrant).includes("homepage-info-boxes"),
    false
  );
  assert.equal(rendered.includes("homepage-info-boxes"), true);
  assert.equal(rendered.includes("update-rules"), false);
  assert.equal(rendered.includes("update-faq"), false);
  assert.equal(rendered.includes("coin-launch-links"), false);
  assert.equal(rendered.includes("cycle-management"), false);
});

test("Community Votes management needs only community.polls.manage", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["community.polls.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(JSON.stringify(withoutGrant).includes("community-polls"), false);
  assert.equal(rendered.includes("community-polls"), true);
  assert.equal(rendered.includes("homepage-info-boxes"), false);
  assert.equal(rendered.includes("winner-payouts"), false);
});

test("Donation Organization management needs only its exact capability", () => {
  const withoutGrant = resolveTeamAreaNavigation(context());
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["donation_organizations.manage"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(JSON.stringify(withoutGrant).includes("donation-organizations"), false);
  assert.equal(rendered.includes("donation-organizations"), true);
  assert.equal(rendered.includes("community-polls"), false);
  assert.equal(rendered.includes("winner-payouts"), false);
});

test("Winner Payouts navigation needs only its exact read capability", () => {
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["winners.payouts.view"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(rendered.includes("winner-payouts"), true);
  assert.equal(rendered.includes("cycle-management"), false);
  assert.equal(rendered.includes("sponsor-reports"), false);
  assert.equal(rendered.includes("social-logs"), false);
});

test("Sponsor Reports navigation needs only its exact read capability", () => {
  const withGrant = resolveTeamAreaNavigation(
    context({ capabilities: ["sponsorships.reports.view"] })
  );
  const rendered = JSON.stringify(withGrant);

  assert.equal(rendered.includes("sponsor-reports"), true);
  assert.equal(rendered.includes("winner-payouts"), false);
  assert.equal(rendered.includes("cycle-management"), false);
  assert.equal(rendered.includes("legal-review"), false);
});

test("admin remains a hard role requirement rather than a capability grant", () => {
  assert.equal(
    meetsTeamAreaRequirement(
      context({
        role: "moderator",
        capabilities: [
          "submissions.submission_phase.disqualify",
          "users.flag.create",
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
    capabilities: ["users.flag.create", "users.directory.basic.view"],
  };
  assert.equal(
    meetsTeamAreaRequirement(
      context({ capabilities: ["users.flag.create"] }),
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
  assert.match(shell, /aria-expanded=\{open\}/);
  assert.match(shell, /aria-controls=\{listId\}/);
  assert.match(shell, /category\.badges/);
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
    /getTeamAuthorizationContext\(\)/
  );
  assert.match(users, /hasResolvedTeamCapability/);
  assert.match(users, /"users\.directory\.basic\.view"/);
  assert.match(users, /"users\.flag\.create"/);
  assert.match(users, /"users\.flag\.view"/);
  assert.match(legal, /requireAdminPage/);
});
