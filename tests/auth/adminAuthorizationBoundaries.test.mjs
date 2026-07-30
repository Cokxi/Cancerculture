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
  "app/api/admin/upload-blocks/route.ts",
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
    "app/admin/flags/page.tsx",
    "app/admin/bans/page.tsx",
    "app/admin/mods/page.tsx",
    "app/admin/team/roles/page.tsx",
    "app/admin/team/members/page.tsx",
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
    "app/admin/actions/unflagUser.ts",
    "app/admin/actions/banUser.ts",
    "app/admin/actions/unbanUser.ts",
    "app/admin/actions/updateRulesVersion.ts",
    "app/admin/cycles/phaseActions.ts",
    "app/admin/cycles/updateCycleHud.ts",
    "app/admin/cycles/updateCycleTimer.ts",
    "app/admin/cycles/updateNextTheme.ts",
  ]) {
    assert.match(await source(file), /requireAdmin\(\)/, file);
  }
});

test("all log pages are protected by a server admin layout", async () => {
  const logsLayout = await source("app/admin/logs/layout.tsx");

  assert.match(logsLayout, /await requireAdminPage\("\/admin\/logs"\)/);
});

test("submission moderation uses only the submission capability guard", async () => {
  for (const file of [
    "app/api/admin/disqualify/route.ts",
    "app/api/admin/reinstate/route.ts",
    "app/api/admin/submissions/route.ts",
  ]) {
    const contents = await source(file);

    assert.match(contents, /requireSubmissionModerator\(\)/, file);
    assert.doesNotMatch(contents, /requireAdmin\(\)/, file);
  }

  for (const file of [
    "app/admin/moderation/submissions/page.tsx",
    "app/admin/moderation/disqualified/page.tsx",
  ]) {
    assert.match(
      await source(file),
      /requireSubmissionModeratorPage\(/,
      file
    );
  }
});

test("flagging and unflagging have distinct server capabilities", async () => {
  const [flag, unflag] = await Promise.all([
    source("app/admin/actions/flagUser.ts"),
    source("app/admin/actions/unflagUser.ts"),
  ]);

  assert.match(
    flag,
    /requireDynamicTeamCapability\("users\.flag"\)/
  );
  assert.doesNotMatch(flag, /requireAdmin\(\)/);
  assert.match(unflag, /requireAdmin\(\)/);
});

test("user page and API share the minimal-directory capability and projection", async () => {
  const [page, route] = await Promise.all([
    source("app/admin/users/page.tsx"),
    source("app/api/admin/user-logs/route.ts"),
  ]);

  for (const contents of [page, route]) {
    assert.match(
      contents,
      /requireDynamicTeamCapability\(\s*"users\.directory\.basic\.view"/
    );
    assert.match(
      contents,
      /getUserDirectoryQuery\(\s*authorization\.isAdmin/
    );
  }

  assert.match(page, /isAdmin && user\.flag_reason_code/);
  assert.match(page, /isAdmin && user\.is_banned/);
  assert.match(page, /\{isAdmin && user\.flag_reason_code/);
  assert.match(page, /\{isAdmin \? <th align="left">Stats/);
  assert.match(
    route,
    /directoryQuery\.isAdminView[\s\S]*display_name: formatDiscordUserLabel\(user\)/
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
  assert.match(navigation, /isAdmin = false/);
  assert.doesNotMatch(navigation, /teamRole|hasTeamCapability/);
  assert.match(
    authorization,
    /result\.isAdmin !== \(result\.roleKey === "admin"\)/
  );
  assert.match(
    authorization,
    /context\.isAdmin \|\|[\s\S]*resolvedCapabilities\.includes/
  );
});
