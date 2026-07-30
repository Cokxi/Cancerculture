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

test("existing guards remain the sole production authorization authority", async () => {
  const [guards, teamRoles] = await Promise.all([
    source("lib/auth/guards.ts"),
    source("lib/auth/teamRoles.ts"),
  ]);

  assert.match(
    guards,
    /export async function requireAdmin[\s\S]*isAdminTeamRole\(member\.role\)/
  );
  assert.match(
    guards,
    /export async function requireTeamCapability[\s\S]*hasTeamCapability\(member\.role, capability\)/
  );
  assert.match(teamRoles, /TEAM_ROLE_CAPABILITIES/);

  for (const sourceText of [guards, teamRoles]) {
    assert.doesNotMatch(
      sourceText,
      /dynamicTeamAuthorization|readDynamicTeamAuthorization|teamAuthorizationShadow/
    );
  }
});

test("no Page, API, Action, navigation, or guard imports the shadow resolver", async () => {
  const files = [
    ...(await sourceFiles("app")),
    ...(await sourceFiles("lib")),
  ];
  const allowed = new Set([
    "lib\\auth\\dynamicTeamAuthorization.ts",
    "lib\\auth\\readDynamicTeamAuthorization.ts",
    "lib\\auth\\teamAuthorizationShadow.ts",
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

test("the dormant database loader is read-only and projects no profile data", async () => {
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
});

test("reserved voting capabilities remain static-only and outside the registry", async () => {
  const [teamRoles, registry, shadow] = await Promise.all([
    source("lib/auth/teamRoles.ts"),
    source("lib/auth/teamCapabilityRegistry.ts"),
    source("lib/auth/teamAuthorizationShadow.ts"),
  ]);

  for (const capability of [
    "canDisqualifyDuringVoting",
    "canReinstateDuringVoting",
    "canRefundDisqualifiedVotes",
  ]) {
    assert.match(teamRoles, new RegExp(capability));
    assert.doesNotMatch(registry, new RegExp(capability));
    assert.doesNotMatch(shadow, new RegExp(capability));
  }
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
