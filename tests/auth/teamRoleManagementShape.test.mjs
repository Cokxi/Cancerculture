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

test("the canonical role route is admin-only and delegates one atomic RPC", async () => {
  const [route, helper] = await Promise.all([
    source("app/api/admin/team/role/route.ts"),
    source("lib/auth/changeTeamMemberRole.ts"),
  ]);

  assert.match(route, /const admin = await requireAdmin\(\)/);
  assert.match(route, /parseTeamRoleChangePayload/);
  assert.match(route, /changeTeamMemberRole/);
  assert.match(helper, /\.rpc\(\s*"set_team_member_role"/);
  assert.doesNotMatch(route, /\.from\("team_members"\)/);
  assert.doesNotMatch(route, /logAdminAction/);
});

test("the role UI has canonical choices, reason, confirmation, and no legacy choice", async () => {
  const ui = await source(
    "app/admin/users/UserRoleActions.tsx"
  );

  assert.match(ui, /CANONICAL_TEAM_ROLES\.map/);
  assert.match(ui, /Remove from team/);
  assert.match(ui, /Reason \(required\)/);
  assert.match(ui, /window\.confirm/);
  assert.match(ui, /disabled=\{loading/);
  assert.doesNotMatch(ui, /Make Mod|Remove Mod|value="mod"/);
});

test("no production TypeScript source writes or directly compares the legacy role", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const offenders = [];

  for (const file of files) {
    const contents = await source(file);

    if (
      /role\s*:\s*["']mod["']/u.test(contents) ||
      /role\s*[!=]==?\s*["']mod["']/u.test(contents) ||
      /\.eq\(\s*["']role["']\s*,\s*["']mod["']\s*\)/u.test(
        contents
      )
    ) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);
});

test("the legacy removal endpoint and call-site are gone", async () => {
  const modsPage = await source("app/admin/mods/page.tsx");

  await assert.rejects(
    source("app/api/admin/mods/remove/route.ts"),
    { code: "ENOENT" }
  );
  assert.doesNotMatch(modsPage, /\/api\/admin\/mods\/remove/);
  assert.match(modsPage, /<UserRoleActions/);
});

test("vote-phase capabilities remain unconnected to production paths", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const reservedCapabilities = [
    "canDisqualifyDuringVoting",
    "canReinstateDuringVoting",
    "canRefundDisqualifiedVotes",
  ];

  for (const capability of reservedCapabilities) {
    const consumers = [];

    for (const file of files) {
      if ((await source(file)).includes(capability)) {
        consumers.push(file.replaceAll("\\", "/"));
      }
    }

    assert.deepEqual(consumers, ["lib/auth/teamRoles.ts"]);
  }

  const disqualification = await source(
    "lib/moderation/setSubmissionDisqualification.ts"
  );
  assert.match(disqualification, /submission_open/);
  assert.doesNotMatch(disqualification, /voting_open/);
});
