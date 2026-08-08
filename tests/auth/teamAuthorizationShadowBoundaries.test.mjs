import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("dynamic authorization is the production authority for connected capabilities", async () => {
  const [guards, authorization, teamRoles] = await Promise.all([
    source("lib/auth/guards.ts"),
    source("lib/auth/teamAuthorization.ts"),
    source("lib/auth/teamRoles.ts"),
  ]);

  assert.match(
    guards,
    /export async function requireAdmin[\s\S]*isAdminTeamRole\(member\.role\)/
  );
  assert.doesNotMatch(guards, /requireSubmissionModerator/u);
  assert.match(
    authorization,
    /export async function requireDynamicTeamCapability/
  );
  assert.match(
    authorization,
    /readDynamicTeamAuthorizationForDiscordUserId/
  );
  assert.doesNotMatch(
    authorization,
    /TEAM_ROLE_CAPABILITIES|hasTeamCapability/
  );
  assert.match(teamRoles, /TEAM_ROLE_CAPABILITIES/);
});

test("only the central context and shadow modules import the low-level dynamic resolver", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const allowed = new Set([
    "lib\\auth\\dynamicTeamAuthorization.ts",
    "lib\\auth\\readDynamicTeamAuthorization.ts",
    "lib\\auth\\teamAuthorizationShadow.ts",
    "lib\\auth\\teamAuthorization.ts",
  ]);
  const offenders = [];

  for (const file of files) {
    if (allowed.has(file)) {
      continue;
    }

    const contents = await source(file);

    if (
      /dynamicTeamAuthorization|readDynamicTeamAuthorization|teamAuthorizationShadow/u.test(
        contents
      )
    ) {
      offenders.push(file.replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(offenders, []);
});

test("the production database loader is read-only and projects no profile data", async () => {
  const loader = await source(
    "lib/auth/readDynamicTeamAuthorization.ts"
  );

  for (const table of [
    "team_members",
    "team_roles",
    "capability_catalog",
    "team_role_capabilities",
  ]) {
    assert.match(
      loader,
      new RegExp(`\\.from\\("${table}"\\)`)
    );
  }

  assert.match(loader, /\.select\("role"\)/);
  assert.match(loader, /\.select\("key, is_active"\)/);
  assert.doesNotMatch(
    loader,
    /\.(?:insert|update|delete|upsert|rpc)\(/
  );
  assert.doesNotMatch(
    loader,
    /profile|session|email|username|console\./i
  );
  assert.doesNotMatch(
    loader,
    /\.from\("team_role_capabilities"\)[\s\S]*?\.eq\("role_key"/u,
    "tombstone compatibility must inspect grants for every role"
  );
});

test("target call-sites no longer make static authorization decisions", async () => {
  const targetFiles = [
    "lib/auth/accountNavigation.ts",
    "app/components/auth/GlobalAccount.tsx",
    "app/admin/layout.tsx",
    "app/admin/moderation/submissions/page.tsx",
    "app/admin/moderation/disqualified/page.tsx",
    "app/api/admin/disqualify/route.ts",
    "app/api/admin/reinstate/route.ts",
    "app/admin/actions/flagUser.ts",
    "app/admin/users/UserModerationActions.tsx",
    "app/admin/users/page.tsx",
    "app/api/admin/user-logs/route.ts",
    "lib/admin/userDirectoryAccess.ts",
  ];

  for (const file of targetFiles) {
    const contents = await source(file);
    assert.doesNotMatch(
      contents,
      /TEAM_ROLE_CAPABILITIES|hasTeamCapability|isAdminTeamRole/u,
      file
    );
    assert.doesNotMatch(
      contents,
      /"canModerateSubmissionPhase"|"canFlagUsers"|"canViewBasicUserDirectory"/u,
      file
    );
  }

  const [guards, uiGuards, moderationAuthorization] =
    await Promise.all([
      source("lib/auth/guards.ts"),
      source("lib/auth/guards.ui.ts"),
      source(
        "lib/moderation/submissionModerationAuthorization.ts"
      ),
    ]);
  assert.doesNotMatch(guards, /requireSubmissionModerator/u);
  assert.doesNotMatch(uiGuards, /requireSubmissionModeratorUI/u);
  assert.match(
    moderationAuthorization,
    /SUBMISSION_MODERATION_CAPABILITIES/u
  );
  assert.doesNotMatch(
    moderationAuthorization,
    /hasTeamCapability|canModerateSubmissionPhase/u
  );
});

test("legacy static voting booleans remain disconnected from granular registry keys", async () => {
  const [teamRoles, registry, shadow] = await Promise.all([
    source("lib/auth/teamRoles.ts"),
    source("lib/auth/teamCapabilityRegistry.ts"),
    source("lib/auth/teamAuthorizationShadow.ts"),
  ]);

  for (const capability of [
    "canDisqualifyDuringVoting",
    "canReinstateDuringVoting",
  ]) {
    assert.match(teamRoles, new RegExp(capability));
    assert.doesNotMatch(registry, new RegExp(capability));
    assert.doesNotMatch(shadow, new RegExp(capability));
  }
  assert.doesNotMatch(teamRoles, /canRefundDisqualifiedVotes/u);
});

test("the committed Foundation migration remains byte-for-byte unchanged", async () => {
  const migration = await readFile(
    path.join(
      repoRoot,
      "supabase/migrations/20260730000300_team_role_capability_foundation.sql"
    )
  );

  assert.equal(
    createHash("sha256").update(migration).digest("hex"),
    "f3a1f2ee24abbbad98aaf8eb9a53a0931c957791d0427344105dd74aa0693bc9"
  );
});
