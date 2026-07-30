import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveTeamAreaNavigation,
  TEAM_AREA_NAVIGATION,
} from "../../lib/admin/teamAreaNavigation.ts";
import {
  findActiveTeamAreaItem,
  getTeamAreaBreadcrumbs,
} from "../../lib/admin/teamAreaNavigationState.ts";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const admin = {
  discord_user_id: "owner",
  role: "admin",
  isAdmin: true,
  resolvedCapabilities: [],
};

test("all canonical Team routes including enrollment are registered", () => {
  const team = TEAM_AREA_NAVIGATION.find(
    (category) => category.id === "team"
  );
  const byId = new Map(team.items.map((entry) => [entry.id, entry]));

  assert.deepEqual(
    [
      "team-members",
      "add-team-member",
      "roles-permissions",
      "authorization-history",
    ].map(
      (id) => [byId.get(id)?.href, byId.get(id)?.implemented]
    ),
    [
      ["/admin/team/members", true],
      ["/admin/team/members/add", true],
      ["/admin/team/roles", true],
      ["/admin/team/authorization-history", true],
    ]
  );

  const resolved = resolveTeamAreaNavigation(admin);
  const resolvedTeam = resolved.find((category) => category.id === "team");
  assert.deepEqual(
    resolvedTeam.items.map((entry) => entry.id),
    [
      "team-members",
      "add-team-member",
      "roles-permissions",
      "authorization-history",
    ]
  );
});

test("Team routes retain breadcrumbs and active state from the central definition", () => {
  const navigation = resolveTeamAreaNavigation(admin);
  for (const [path, id, breadcrumbs] of [
    [
      "/admin/team/members",
      "team-members",
      ["Team Area", "Team", "Team Members"],
    ],
    [
      "/admin/team/members/add",
      "add-team-member",
      ["Team Area", "Team", "Add Team Member"],
    ],
    [
      "/admin/team/roles",
      "roles-permissions",
      ["Team Area", "Team", "Roles & Permissions"],
    ],
    [
      "/admin/team/authorization-history",
      "authorization-history",
      ["Team Area", "Team", "Authorization History"],
    ],
  ]) {
    assert.equal(findActiveTeamAreaItem(navigation, path)?.entry.id, id);
    assert.deepEqual(getTeamAreaBreadcrumbs(navigation, path), breadcrumbs);
  }
});

test("all four pages guard before loading their server read models", async () => {
  for (const path of [
    "app/admin/team/members/page.tsx",
    "app/admin/team/members/add/page.tsx",
    "app/admin/team/roles/page.tsx",
    "app/admin/team/authorization-history/page.tsx",
  ]) {
    const page = await source(path);
    assert.match(page, /requireAdminPage\(/, path);
    assert.ok(
      page.indexOf("requireAdminPage") <
        page.indexOf("await load"),
      path
    );
    assert.match(page, /getTeamPageAccessRedirect/, path);
  }
});

test("the legacy team route guards and redirects directly to the canonical role page", async () => {
  const legacy = await source("app/admin/mods/page.tsx");
  assert.match(legacy, /requireAdminPage\("\/admin\/mods"\)/);
  assert.match(legacy, /redirect\("\/admin\/team\/roles"\)/);
  assert.ok(
    legacy.indexOf("requireAdminPage") <
      legacy.indexOf('redirect("/admin/team/roles")')
  );
});

test("Team Members exposes only the narrow member projection and secure transitions", async () => {
  const [page, ui] = await Promise.all([
    source("app/admin/team/members/page.tsx"),
    source("app/admin/team/members/TeamMembersClient.tsx"),
  ]);

  assert.match(page, /loadTeamMembersAdminReadModel/);
  for (const sensitive of [
    "session_id",
    "wallet_address",
    "vote_count",
    "social_profile",
    "ban_reason",
    "discord_sync_state",
  ]) {
    assert.doesNotMatch(`${page}\n${ui}`, new RegExp(sensitive, "iu"));
  }
  assert.match(ui, /activeNonAdminRoles\.map/);
  assert.match(ui, /expectedPreviousRoleKey: member\.roleKey/);
  assert.match(ui, /operation: "set_member_non_admin_role"/);
  assert.match(ui, /Owner Accounts/);
  assert.match(ui, /operation: "set_member_admin_role"/);
  assert.match(ui, /confirmationWord: "ADMIN"/);
  assert.match(ui, /Self-demotion is not offered/);
  assert.match(page, /Add Team Member/);
  assert.match(page, /\/admin\/team\/members\/add/);
  assert.match(ui, /Remove Team Member/);
  assert.match(ui, /operation: "remove_team_member"/);
  assert.match(
    ui,
    /expectedPreviousRoleKey: member\.roleKey/
  );
  assert.match(ui, /confirmationWord: "REMOVE"/);
  assert.match(ui, /members\.filter\([\s\S]*!member\.isAdmin/);
  assert.doesNotMatch(ui, /\.(?:insert|update|delete)\(/);
});

test("Add Team Member uses the narrow role projection and shared safe mutation flow", async () => {
  const [page, ui, model] = await Promise.all([
    source("app/admin/team/members/add/page.tsx"),
    source("app/admin/team/members/add/AddTeamMemberClient.tsx"),
    source("lib/auth/teamRoleAdminReadModel.ts"),
  ]);

  assert.match(page, /loadAddTeamMemberAdminReadModel/);
  assert.match(ui, /name="targetDiscordUserId"/);
  assert.match(ui, /pattern="\[0-9\]\{5,32\}"/);
  assert.match(ui, /required/);
  assert.doesNotMatch(ui, /username/iu);
  assert.match(ui, /roles\.map/);
  assert.match(ui, /operation: "add_team_member"/);
  assert.match(ui, /initialRoleKey: role\.key/);
  assert.match(ui, /confirmationWord: "ADD"/);
  assert.match(ui, /redirectOnSuccess/);
  assert.doesNotMatch(ui, /expected_absent|actorDiscordUserId/);
  assert.doesNotMatch(ui, /\.(?:insert|update|delete)\(/);

  const addLoader = model.slice(
    model.indexOf(
      "export async function loadAddTeamMemberAdminReadModel"
    ),
    model.indexOf(
      "export async function loadRolesPermissionsAdminReadModel"
    )
  );
  assert.match(addLoader, /\.from\("team_roles"\)/);
  assert.doesNotMatch(
    addLoader,
    /team_members|user_logs|discord_member_state|capability_catalog|team_authorization_audit/
  );
});

test("page-specific server read models avoid loading unrelated Team data", async () => {
  const model = await source("lib/auth/teamRoleAdminReadModel.ts");
  const membersLoader = model.slice(
    model.indexOf("export async function loadTeamMembersAdminReadModel"),
    model.indexOf(
      "export async function loadRolesPermissionsAdminReadModel"
    )
  );
  const rolesLoader = model.slice(
    model.indexOf(
      "export async function loadRolesPermissionsAdminReadModel"
    ),
    model.indexOf(
      "export async function loadTeamAuthorizationHistoryReadModel"
    )
  );
  const historyLoader = model.slice(
    model.indexOf(
      "export async function loadTeamAuthorizationHistoryReadModel"
    )
  );

  assert.match(membersLoader, /\.from\("team_roles"\)/);
  assert.match(membersLoader, /\.from\("team_members"\)/);
  assert.doesNotMatch(
    membersLoader,
    /capability_catalog|team_role_capabilities|team_authorization_audit/
  );
  assert.match(rolesLoader, /\.from\("capability_catalog"\)/);
  assert.match(rolesLoader, /\.from\("team_role_capabilities"\)/);
  assert.doesNotMatch(rolesLoader, /team_authorization_audit/);
  assert.match(historyLoader, /\.from\("team_authorization_audit"\)/);
  assert.doesNotMatch(
    historyLoader,
    /\.from\("(?:team_roles|team_members|capability_catalog|team_role_capabilities)"\)/
  );
});

test("Roles & Permissions renders three compact responsive rows with active dynamic role controls", async () => {
  const [page, ui, registry] = await Promise.all([
    source("app/admin/team/roles/page.tsx"),
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
    source("lib/auth/teamCapabilityRegistry.ts"),
  ]);

  assert.match(page, /REGISTERED_TEAM_CAPABILITY_KEYS\.map/);
  assert.equal(
    [
      "submissions.submission_phase.moderate",
      "users.flag",
      "users.directory.basic.view",
    ].filter((key) => registry.includes(`"${key}"`)).length,
    3
  );
  assert.match(ui, /readModel\.capabilities\.map/);
  assert.match(ui, /roles=\{readModel\.activeNonAdminRoles\}/);
  assert.match(ui, /<article[\s\S]*aria-labelledby=\{headingId\}/);
  assert.match(ui, /data-capability-layout/);
  assert.match(ui, /data-role-controls/);
  assert.match(ui, /data-role-control/);
  assert.match(ui, /trial_moderator: "T Mod"/);
  assert.match(ui, /moderator: "Mod"/);
  assert.match(ui, /super_moderator: "S Mod"/);
  assert.match(ui, /builtInRoleLabels\[role\.key\] \?\? role\.displayName/);
  assert.doesNotMatch(ui, /<table|overflow-x-auto|Capability matrix/);
  assert.match(ui, /✓ Saved · Granted/);
  assert.match(ui, /useState\(false\)/);
  assert.match(ui, /aria-expanded=\{detailsExpanded\}/);
  assert.match(ui, /aria-controls=\{detailsId\}/);
  assert.match(ui, />\s*Details\s*<\/button>/);
  assert.match(ui, /setDetailsExpanded\(\(expanded\) => !expanded\)/);
  assert.match(ui, /hidden=\{!detailsExpanded\}/);
  const capabilityBlock = ui.slice(ui.indexOf("function CapabilityBlock"));
  assert.doesNotMatch(capabilityBlock, /capability\.description/);
  assert.match(
    ui,
    /capability\.description\.trim\(\)\.length > 0[\s\S]*capability\.description/
  );
  assert.match(ui, /capability\.includedActions\.length > 0/);
  assert.match(ui, /capability\.excludedActions\.length > 0/);
  assert.match(ui, /\{granted \? "Revoke" : "Grant"\}/);
});

test("single mutations show pending, refresh only after success, and keep errors in the dialog", async () => {
  const mutation = await source(
    "app/admin/team/TeamRoleMutationClient.tsx"
  );

  assert.match(mutation, /setBusy\(true\)/);
  assert.match(mutation, /\{busy \? "Applying…" : "Confirm change"\}/);
  const errorBranch = mutation.indexOf("if (!response.ok)");
  const confirmedSuccess = mutation.indexOf(
    "setSuccessMessage(",
    errorBranch
  );
  assert.ok(errorBranch < confirmedSuccess);
  assert.ok(
    confirmedSuccess <
      mutation.indexOf("router.refresh()", confirmedSuccess)
  );
  assert.match(mutation, /setDialogError\(errorMessage|setDialogError\(/);
  assert.match(mutation, /Retry keeps the same idempotency key/);
  assert.match(mutation, /response\.status === 404/);
  assert.doesNotMatch(
    mutation,
    /Review changes|confirmationWord:\s*"SAVE"|batch/i
  );
});

test("custom role administration retains the hardened single mutation contract without auto-grants", async () => {
  const ui = await source(
    "app/admin/team/roles/RolesPermissionsClient.tsx"
  );

  assert.match(ui, /Create Custom Team Role/);
  assert.match(ui, /operation: "create_role"/);
  assert.match(ui, /zero\s+grants/);
  assert.match(ui, /operation: "update_role"/);
  assert.match(ui, /operation: "set_role_active"/);
  assert.doesNotMatch(ui, /\.(?:insert|update|delete)\(/);
  assert.doesNotMatch(ui, />\s*Delete role\s*</);
});

test("Authorization History is a server-rendered read-only projection", async () => {
  const [page, list] = await Promise.all([
    source("app/admin/team/authorization-history/page.tsx"),
    source(
      "app/admin/team/authorization-history/AuthorizationHistoryList.tsx"
    ),
  ]);

  assert.match(page, /audit=\{readModel\.audit\}/);
  for (const field of [
    "occurredAt",
    "eventType",
    "actorDiscordUserId",
    "targetRoleKey",
    "capabilityKey",
    "targetDiscordUserId",
    "reason",
    "beforeState",
    "afterState",
  ]) {
    assert.match(list, new RegExp(`entry\\.${field}`));
  }
  assert.doesNotMatch(`${page}\n${list}`, /"use client"|fetch\(|<form|<button/);
  assert.doesNotMatch(`${page}\n${list}`, /\.(?:insert|update|delete)\(/);
  assert.doesNotMatch(page, /\.from\("team_authorization_audit"\)/);
  assert.match(list, /member_added: "Team member added"/);
  assert.match(list, /member_removed: "Team member removed"/);
});

test("desktop and mobile remain consumers of one resolved navigation structure", async () => {
  const shell = await source("app/admin/TeamAreaShell.tsx");
  assert.equal(shell.match(/<NavigationGroups/g)?.length, 2);
  assert.match(shell, /navigation=\{navigation\}/);
});
