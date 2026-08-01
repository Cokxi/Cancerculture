import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const source = (relativePath) =>
  readFile(path.join(repoRoot, relativePath), "utf8");

async function sourceFiles(directory) {
  const entries = await readdir(path.join(repoRoot, directory));
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(directory, entry);
    const details = await stat(path.join(repoRoot, relativePath));

    if (details.isDirectory()) {
      files.push(...(await sourceFiles(relativePath)));
    } else if (/\.(?:ts|tsx)$/u.test(entry)) {
      files.push(relativePath);
    }
  }

  return files;
}

const adminOnlyRoutes = [
  "app/api/admin/logs/route.ts",
  "app/api/admin/logs/uploads/route.ts",
  "app/api/admin/logs/avatar-uploads/route.ts",
  "app/api/admin/logs/votes/route.ts",
  "app/api/admin/logs/blocked/route.ts",
  "app/api/admin/logs/blocked/handled/route.ts",
  "app/api/admin/logs/moderation/route.ts",
  "app/api/admin/logs/moderation/by-cycle/route.ts",
  "app/api/admin/socials/[socialId]/verify/route.ts",
  "app/api/admin/socials/[socialId]/unverify/route.ts",
  "app/api/admin/submissions/public-visibility/route.ts",
  "app/api/admin/team/role/route.ts",
  "app/api/admin/team/roles/route.ts",
  "app/api/admin/discord-sync/route.ts",
  "app/api/admin/cycles/start/route.ts",
  "app/api/admin/cycles/end/route.ts",
  "app/api/admin/cycles/reset/route.ts",
  "app/api/admin/submissions/[submissionId]/export/route.ts",
  "app/api/admin/sponsors/[sponsorshipId]/export/route.ts",
];

test("sensitive APIs all enforce the independent admin guard", async () => {
  for (const file of adminOnlyRoutes) {
    const contents = await source(file);

    assert.match(contents, /requireAdmin\(\)/, file);
    assert.doesNotMatch(
      contents,
      /requireSubmissionModerator|requireTeamCapability|requireDynamicTeamCapability/,
      file
    );
  }
});

test("upload block viewing is delegable while emergency unblock stays Admin-only", async () => {
  const route = await source("app/api/admin/upload-blocks/route.ts");

  assert.match(
    route,
    /export async function GET\(\)[\s\S]*?requireDynamicTeamCapability\("users\.upload_blocks\.view"\)/
  );
  assert.match(
    route,
    /export async function POST\(req: Request\)[\s\S]*?requireAdmin\(\)/
  );
});

test("rules and social administration are server-side admin-only", async () => {
  const [rules, socialLogs] = await Promise.all([
    source("app/admin/actions/updateRulesVersion.ts"),
    source("app/admin/logs/socials/page.tsx"),
  ]);

  assert.match(rules, /await requireAdmin\(\)/);
  assert.match(socialLogs, /await requireAdminPage\(/);
});

test("admin pages and owner actions keep explicit server guards", async () => {
  for (const file of [
    "app/admin/cycles/page.tsx",
    "app/admin/mods/page.tsx",
    "app/admin/team/roles/page.tsx",
    "app/admin/team/members/page.tsx",
    "app/admin/team/members/add/page.tsx",
    "app/admin/team/authorization-history/page.tsx",
    "app/admin/moderation/legal-review/page.tsx",
    "app/admin/coin-launches/page.tsx",
    "app/admin/homepage-info-blocks/page.tsx",
  ]) {
    assert.match(
      await source(file),
      /requireAdmin(?:Page)?\(/,
      file
    );
  }

  for (const file of [
    "app/admin/actions/updateRulesVersion.ts",
    "app/admin/cycles/phaseActions.ts",
    "app/admin/cycles/updateCycleHud.ts",
    "app/admin/cycles/updateCycleTimer.ts",
    "app/admin/cycles/updateNextTheme.ts",
  ]) {
    assert.match(await source(file), /requireAdmin\(\)/, file);
  }
});

test("website ban view, create, and revoke use separate capability guards", async () => {
  const [page, createAction, revokeAction] = await Promise.all([
    source("app/admin/bans/page.tsx"),
    source("app/admin/actions/banUser.ts"),
    source("app/admin/actions/unbanUser.ts"),
  ]);

  assert.match(page, /requireTeamCapabilityPage\(\s*"users\.website_bans\.view"/);
  assert.match(createAction, /requireDynamicTeamCapability\(\s*"users\.website_bans\.create"/);
  assert.match(revokeAction, /requireDynamicTeamCapability\(\s*"users\.website_bans\.revoke"/);
  assert.doesNotMatch(revokeAction, /\.from\("user_logs"\)\s*\.update/);
});

test("all log pages are protected by a server admin layout", async () => {
  const logsLayout = await source("app/admin/logs/layout.tsx");

  assert.match(logsLayout, /await requireAdminPage\("\/admin\/logs"\)/);
});

test("submission moderation uses only the exact phase and operation capability guard", async () => {
  for (const file of [
    "app/api/admin/disqualify/route.ts",
    "app/api/admin/reinstate/route.ts",
  ]) {
    const contents = await source(file);

    assert.match(contents, /requireSubmissionModerationAction\(/, file);
    assert.match(contents, /getTeamAuthorizationContext\(\)/, file);
    assert.doesNotMatch(contents, /requireAdmin\(\)/, file);
  }

  assert.match(
    await source("app/admin/moderation/submissions/page.tsx"),
    /requireLiveModerationPage\(/
  );
  assert.match(
    await source("app/admin/moderation/disqualified/page.tsx"),
    /requireDisqualifiedSubmissionsPage\(/
  );
});

test("flag cases use distinct create, view, and review capabilities", async () => {
  const [flag, review, model, listPage, detailPage] = await Promise.all([
    source("app/admin/actions/flagUser.ts"),
    source("app/admin/actions/reviewUserFlagCase.ts"),
    source("lib/admin/userFlagCases.ts"),
    source("app/admin/flags/page.tsx"),
    source("app/admin/flags/[caseId]/page.tsx"),
  ]);

  assert.match(flag, /createUserFlagCase\(params\)/);
  assert.match(review, /reviewCase\(params\)/);
  assert.match(model, /"users\.flag\.create"/);
  assert.match(model, /"users\.flag\.view"/);
  assert.match(model, /"users\.flag\.review"/);
  assert.match(model, /\.rpc\(\s*"create_user_flag_case"/);
  assert.match(model, /\.rpc\(\s*"list_user_flag_cases"/);
  assert.match(model, /\.rpc\(\s*"get_user_flag_case"/);
  assert.match(model, /\.rpc\(\s*"review_user_flag_case"/);
  assert.doesNotMatch(`${flag}\n${review}\n${model}`, /\.from\("user_flag_/);
  assert.match(listPage, /"users\.flag\.view"/);
  assert.match(detailPage, /"users\.flag\.review"/);
});

test("user page and API compose separate basic and full directory rights", async () => {
  const [page, route] = await Promise.all([
    source("app/admin/users/page.tsx"),
    source("app/api/admin/user-logs/route.ts"),
  ]);

  assert.match(page, /getTeamAuthorizationContext\(\)/);
  assert.match(page, /"users\.directory\.basic\.view"/);
  assert.match(page, /"users\.directory\.full\.view"/);
  assert.match(page, /"users\.flag\.create"/);
  assert.match(page, /"users\.flag\.view"/);
  assert.match(route, /getTeamAuthorizationContext\(\)/);
  assert.match(route, /"users\.directory\.basic\.view"/);
  assert.match(route, /"users\.directory\.full\.view"/);
  assert.match(route, /if \(!canViewBasic && !canViewFull\)/);
  assert.match(page, /getUserDirectoryQuery\(canViewFullDirectory\)/);
  assert.match(route, /getUserDirectoryQuery\(\s*canViewFull/);

  assert.match(page, /canViewWebsiteBans &&/);
  assert.match(page, /\{isFullView \? <th align="left">Stats/);
  assert.doesNotMatch(`${page}\n${route}`, /flagged_for_review|flag_reason_code|flagged_by_discord_user_id/);
  assert.match(
    route,
    /directoryQuery\.isFullView[\s\S]*display_name: formatDiscordUserLabel\(user\)/
  );
  assert.doesNotMatch(
    route,
    /display_name:[\s\S]*known_discord_usernames/
  );
});

test("the broad legacy guard is absent from production sources", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const offenders = [];

  for (const file of files) {
    const contents = await source(file);

    if (
      /requireModOrAdmin(?:Page|UI)?/u.test(contents)
    ) {
      offenders.push(file.replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(offenders, []);
});

test("admin identity is not derived from any configurable capability", async () => {
  const [guards, uiGuards, navigation, authorization] = await Promise.all([
    source("lib/auth/guards.ts"),
    source("lib/auth/guards.ui.ts"),
    source("lib/auth/accountNavigation.ts"),
    source("lib/auth/teamAuthorization.ts"),
  ]);

  assert.match(guards, /if \(!isAdminTeamRole\(member\.role\)\)/);
  assert.doesNotMatch(
    guards.match(
      /export async function requireAdmin[\s\S]*?\n}\n/
    )?.[0] ?? "",
    /canManageTeamRoles/
  );
  assert.match(uiGuards, /if \(!isAdminTeamRole\(member\.role\)\)/);
  assert.match(navigation, /hasVisibleTeamAreaItems = false/);
  assert.doesNotMatch(
    navigation,
    /teamRole|hasTeamCapability|isAdmin|submissions\.submission_phase\.moderate|users\.flag/
  );
  assert.match(
    authorization,
    /result\.isAdmin !== \(result\.roleKey === "admin"\)/
  );
  assert.match(
    authorization,
    /context\.isAdmin \|\|[\s\S]*resolvedCapabilities\.includes/
  );
});
