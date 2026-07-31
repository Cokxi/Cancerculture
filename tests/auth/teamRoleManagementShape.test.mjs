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

test("the canonical page guards before loading and legacy page redirects after guarding", async () => {
  const [page, legacy, navigation] = await Promise.all([
    source("app/admin/team/roles/page.tsx"),
    source("app/admin/mods/page.tsx"),
    source("lib/admin/teamAreaNavigation.ts"),
  ]);

  assert.ok(
    page.indexOf("requireAdminPage") <
      page.indexOf("loadRolesPermissionsAdminReadModel")
  );
  assert.match(page, /getTeamPageAccessRedirect/);
  assert.match(legacy, /requireAdminPage\("\/admin\/mods"\)/);
  assert.ok(
    legacy.indexOf("requireAdminPage") <
      legacy.indexOf('redirect("/admin/team/roles")')
  );
  assert.match(navigation, /title: "Roles & Permissions"/);
  assert.match(navigation, /\/admin\/team\/roles/);
});

test("canonical and compatibility mutation routes are guarded and same-origin", async () => {
  for (const file of [
    "app/api/admin/team/roles/route.ts",
    "app/api/admin/team/role/route.ts",
  ]) {
    const contents = await source(file);
    assert.ok(
      contents.indexOf("requireAdmin()") <
        contents.indexOf("request.json()"),
      file
    );
    assert.match(contents, /requireSameOrigin\(request\)/, file);
    assert.match(contents, /admin\.discord_user_id/, file);
    assert.doesNotMatch(
      contents,
      /p_actor_discord_user_id\s*:\s*payload/u,
      file
    );
  }
});

test("the production mutation adapter calls exactly the nine hardened RPCs", async () => {
  const adapter = await source("lib/auth/teamRoleMutations.ts");
  const rpcNames = [
    ...adapter.matchAll(
      /callMutationRpc\(\s*"([a-z_]+)"/gu
    ),
  ].map((match) => match[1]);

  assert.deepEqual(rpcNames.sort(), [
    "add_team_member",
    "apply_team_role_capability_changes",
    "create_team_role",
    "remove_team_member",
    "set_team_member_admin_role",
    "set_team_member_non_admin_role",
    "set_team_role_active",
    "set_team_role_capability",
    "update_team_role",
  ]);
  assert.doesNotMatch(adapter, /set_team_member_role["']/);
  assert.doesNotMatch(adapter, /\.(?:insert|update|delete)\(/);
});

test("no production source invokes the deprecated role RPC", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const offenders = [];

  for (const file of files) {
    const contents = await source(file);
    if (
      /\.rpc\(\s*["']set_team_member_role["']/u.test(contents)
    ) {
      offenders.push(file.replaceAll("\\", "/"));
    }
  }

  assert.deepEqual(offenders, []);
});

test("foundation tables have no direct production mutation", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const foundationTables = [
    "team_roles",
    "capability_catalog",
    "team_role_capabilities",
    "team_members",
    "team_authorization_audit",
  ];
  const offenders = [];

  for (const file of files) {
    const contents = await source(file);
    for (const table of foundationTables) {
      const relation = contents.indexOf(`.from("${table}")`);
      if (
        relation >= 0 &&
        /\.(?:insert|update|delete)\(/u.test(
          contents.slice(relation)
        )
      ) {
        offenders.push(`${file.replaceAll("\\", "/")}:${table}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("permission rows are semantic, responsive, data-driven, exclude Admin, and lock registry drift", async () => {
  const [shell, ui, page, model] = await Promise.all([
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
    source("app/admin/team/roles/CapabilityDraftWorkflow.tsx"),
    source("app/admin/team/roles/page.tsx"),
    source("lib/auth/teamRoleAdminReadModel.ts"),
  ]);

  assert.match(shell, /capabilities=\{readModel\.capabilities\}/);
  assert.match(ui, /baseCapabilities\.map/);
  assert.match(page, /REGISTERED_TEAM_CAPABILITY_KEYS\.map/);
  assert.match(shell, /activeNonAdminRoles/);
  assert.match(ui, /data-capability-block/);
  assert.match(ui, /data-capability-layout/);
  assert.match(ui, /data-role-controls/);
  assert.match(ui, /aria-expanded=\{detailsExpanded\}/);
  assert.match(ui, /aria-controls=\{detailsId\}/);
  assert.match(ui, /hidden=\{!detailsExpanded\}/);
  assert.match(ui, /capability\.mutable/);
  assert.match(ui, /capability\.implementationVersion/);
  assert.match(ui, /capability\.definitionHash/);
  assert.doesNotMatch(ui, /<table|Capability matrix|overflow-x-auto/);
  assert.doesNotMatch(
    ui,
    /submissions\.submission_phase\.moderate|users\.directory\.basic\.view|users\.flag/
  );
  assert.match(
    model,
    /ACTIVE_TEAM_CAPABILITY_KEYS[\s\S]*snapshot\.capabilityRows/
  );
});

test("the split UI has explicit confirmations, stable retries, owner separation, and no delete", async () => {
  const [mutation, members, roles, workflow] = await Promise.all([
    source("app/admin/team/TeamRoleMutationClient.tsx"),
    source("app/admin/team/members/TeamMembersClient.tsx"),
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
    source("app/admin/team/roles/CapabilityDraftWorkflow.tsx"),
  ]);
  const ui = `${mutation}\n${members}\n${roles}\n${workflow}`;

  assert.match(ui, /<dialog/);
  assert.match(ui, /autoFocus/);
  assert.match(ui, /crypto\.randomUUID\(\)/);
  assert.match(ui, /Retry keeps the same idempotency key/);
  assert.match(ui, /Owner Accounts/);
  assert.match(ui, /confirmationWord/);
  assert.match(ui, /confirmationWord: "REMOVE"/);
  assert.match(ui, /activeNonAdminRoles\.map/);
  assert.match(ui, /isCurrentAdmin/);
  assert.doesNotMatch(ui, />\s*Delete\s*</);
});

test("new capability keys and voting actions remain unconnected to production paths", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  for (const capabilityKey of [
    "submissions.submission_phase.disqualify",
    "submissions.submission_phase.reinstate",
    "submissions.voting_phase.disqualify",
    "submissions.voting_phase.reinstate",
  ]) {
    const consumers = [];
    for (const file of files) {
      if ((await source(file)).includes(capabilityKey)) {
        consumers.push(file.replaceAll("\\", "/"));
      }
    }
    assert.deepEqual(consumers, [
      "lib/auth/teamCapabilityRegistry.ts",
    ]);
  }

  for (const capability of [
    "canDisqualifyDuringVoting",
    "canReinstateDuringVoting",
    "canRefundDisqualifiedVotes",
  ]) {
    const consumers = [];
    for (const file of files) {
      if ((await source(file)).includes(capability)) {
        consumers.push(file.replaceAll("\\", "/"));
      }
    }
    assert.deepEqual(consumers, ["lib/auth/teamRoles.ts"]);
  }
});
