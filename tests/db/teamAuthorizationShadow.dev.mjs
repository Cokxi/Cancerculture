import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

register(
  new URL(
    "../integration/nextAliasLoader.mjs",
    import.meta.url
  )
);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const approvedDevProjectRef = "gceljiuydyiwkomymuqh";
const psql =
  process.env.PSQL_BIN ??
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

async function readDevDatabaseUrl() {
  if (process.env.SUPABASE_DEV_DATABASE_URL) {
    return process.env.SUPABASE_DEV_DATABASE_URL;
  }

  const dotenv = await readFile(
    path.join(repoRoot, ".env.codex.local"),
    "utf8"
  );
  const line = dotenv
    .split(/\r?\n/u)
    .find((candidate) =>
      candidate.startsWith("SUPABASE_DEV_DATABASE_URL=")
    );

  if (!line) {
    throw new Error(
      "SUPABASE_DEV_DATABASE_URL is not configured."
    );
  }

  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/u, "$2");
}

function readFoundationSnapshot(databaseUrl) {
  const sql = `
    begin read only;
    set local lock_timeout = '5s';
    set local statement_timeout = '20s';

    select jsonb_build_object(
      'transactionReadOnly',
        current_setting('transaction_read_only'),
      'roles',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'key', key,
                'displayName', display_name,
                'description', description,
                'isSystem', is_system,
                'isActive', is_active,
                'sortOrder', sort_order,
                'rowVersion', row_version,
                'createdAt', created_at,
                'updatedAt', updated_at,
                'createdByDiscordUserId', created_by_discord_user_id,
                'updatedByDiscordUserId', updated_by_discord_user_id
              )
              order by key
            )
            from public.team_roles
          ),
          '[]'::jsonb
        ),
      'catalog',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'key', key,
                'displayName', display_name,
                'description', description,
                'category', category,
                'includedActions', included_actions,
                'excludedActions', excluded_actions,
                'riskLevel', risk_level,
                'isActive', is_active,
                'assignableToNonAdmin',
                  assignable_to_non_admin,
                'implementationVersion',
                  implementation_version,
                'definitionHash', definition_hash,
                'deprecatedAt', deprecated_at
              )
              order by key
            )
            from public.capability_catalog
          ),
          '[]'::jsonb
        ),
      'grants',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'roleKey', role_key,
                'capabilityKey', capability_key,
                'grantedAt', granted_at,
                'grantedByDiscordUserId', granted_by_discord_user_id,
                'grantReason', grant_reason
              )
              order by role_key, capability_key
            )
            from public.team_role_capabilities
          ),
          '[]'::jsonb
        ),
      'memberRoleCounts',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'roleKey', role_counts.role,
                'count', role_counts.member_count
              )
              order by role_counts.role
            )
            from (
              select role, count(*)::integer as member_count
              from public.team_members
              group by role
            ) role_counts
          ),
          '[]'::jsonb
        ),
      'members',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'discordUserId', discord_user_id,
                'discordUsername', discord_username,
                'role', role
              )
              order by discord_user_id
            )
            from public.team_members
          ),
          '[]'::jsonb
        )
    );

    rollback;
  `;
  const execution = spawnSync(
    psql,
    [
      databaseUrl,
      "-X",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ],
    {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1_000_000,
      encoding: "utf8",
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: "10",
        PGOPTIONS:
          "-c default_transaction_read_only=on",
      },
    }
  );

  if (execution.error || execution.status !== 0) {
    throw new Error(
      "The read-only DEV authorization query failed."
    );
  }

  const jsonLine = execution.stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith("{"));

  if (!jsonLine) {
    throw new Error(
      "The read-only DEV authorization query returned no snapshot."
    );
  }

  return JSON.parse(jsonLine);
}

const databaseUrl = await readDevDatabaseUrl();

if (!databaseUrl.includes(approvedDevProjectRef)) {
  throw new Error(
    "Refusing to query a database other than the approved DEV project."
  );
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??=
  "https://staged-capability-smoke.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??=
  "staged-capability-smoke-service-key";

const [
  {
    REGISTERED_TEAM_CAPABILITY_KEYS,
    TEAM_CAPABILITY_REGISTRY,
  },
  { resolveDynamicTeamAuthorizationSnapshot },
  { compareTeamAuthorizationShadow },
  { resolveTeamAreaNavigation },
  { createAccountNavigationState },
  { buildTeamRoleAdminReadModel },
  { permissionSnapshotFingerprint },
] = await Promise.all([
  import("../../lib/auth/teamCapabilityRegistry.ts"),
  import("../../lib/auth/dynamicTeamAuthorization.ts"),
  import("../../lib/auth/teamAuthorizationShadow.ts"),
  import("../../lib/admin/teamAreaNavigation.ts"),
  import("../../lib/auth/accountNavigation.ts"),
  import("../../lib/auth/teamRoleAdminReadModel.ts"),
  import("../../lib/auth/teamCapabilityBatchDraft.ts"),
]);
const snapshot = readFoundationSnapshot(databaseUrl);
const expectedRoles = [
  "admin",
  "moderator",
  "super_moderator",
  "trial_moderator",
];
const expectedStagedCapabilityKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
];

assert.equal(snapshot.transactionReadOnly, "on");
assert.deepEqual(
  snapshot.roles.map((role) => role.key),
  expectedRoles
);
assert.equal(
  snapshot.roles.every((role) => role.isActive === true),
  true
);
assert.deepEqual(
  snapshot.catalog.map((entry) => entry.key),
  [
    ...REGISTERED_TEAM_CAPABILITY_KEYS,
    ...expectedStagedCapabilityKeys,
  ].sort()
);

for (const entry of snapshot.catalog) {
  const registered = TEAM_CAPABILITY_REGISTRY[entry.key];

  if (registered) {
    assert.equal(entry.isActive, true);
    assert.equal(entry.assignableToNonAdmin, true);
    assert.equal(
      entry.implementationVersion,
      registered.implementationVersion
    );
    assert.equal(
      entry.definitionHash,
      registered.definitionHash
    );
  } else {
    assert.equal(expectedStagedCapabilityKeys.includes(entry.key), true);
    assert.equal(entry.isActive, false);
    assert.equal(entry.assignableToNonAdmin, false);
    assert.equal(
      snapshot.grants.some(
        (grant) => grant.capabilityKey === entry.key
      ),
      false
    );
  }
}

assert.equal(snapshot.grants.length, 7);
assert.equal(
  snapshot.grants.some(
    (grant) => grant.roleKey === "admin"
  ),
  false
);

let trialModeratorResult = null;
let shadowMatchCount = 0;

for (const roleKey of expectedRoles) {
  const dynamicResult =
    resolveDynamicTeamAuthorizationSnapshot({
      teamMemberRoleKey: roleKey,
      roles: snapshot.roles,
      catalog: snapshot.catalog,
      grants: snapshot.grants,
    });
  const shadow =
    compareTeamAuthorizationShadow(dynamicResult);

  assert.equal(dynamicResult.status, "resolved");
  assert.equal(shadow.dynamicStatus, "resolved");
  if (shadow.isMatch) {
    shadowMatchCount += 1;
  }

  if (roleKey === "admin") {
    assert.equal(dynamicResult.isAdmin, true);
    assert.deepEqual(
      dynamicResult.resolvedCapabilities,
      []
    );
  } else {
    assert.equal(dynamicResult.isAdmin, false);
    const roleGrantKeys = new Set(
      snapshot.grants
        .filter((grant) => grant.roleKey === roleKey)
        .map((grant) => grant.capabilityKey)
    );
    assert.deepEqual(
      dynamicResult.resolvedCapabilities,
      REGISTERED_TEAM_CAPABILITY_KEYS.filter((capabilityKey) =>
        roleGrantKeys.has(capabilityKey)
      )
    );
    if (roleKey === "trial_moderator") {
      trialModeratorResult = dynamicResult;
    }
  }
}

assert.ok(trialModeratorResult);
assert.deepEqual(
  trialModeratorResult.resolvedCapabilities,
  ["users.directory.basic.view"]
);
const trialNavigation = resolveTeamAreaNavigation({
  role: trialModeratorResult.roleKey,
  isAdmin: trialModeratorResult.isAdmin,
  resolvedCapabilities: trialModeratorResult.resolvedCapabilities,
});
assert.equal(
  trialNavigation.some((category) =>
    category.items.some((entry) => entry.id === "user-logs")
  ),
  true
);
const trialAccount = createAccountNavigationState({
  sessionStatus: "authenticated",
  hasVisibleTeamAreaItems: trialNavigation.length > 0,
});
assert.equal(
  trialAccount.items.some((entry) => entry.id === "team_area"),
  true
);

const adminMember = snapshot.members.find(
  (member) => member.role === "admin"
);
assert.ok(adminMember);
const roleReadModel = buildTeamRoleAdminReadModel({
  roleRows: snapshot.roles.map((role) => ({
    key: role.key,
    display_name: role.displayName,
    description: role.description,
    is_system: role.isSystem,
    is_active: role.isActive,
    sort_order: role.sortOrder,
    row_version: role.rowVersion,
    created_at: role.createdAt,
    updated_at: role.updatedAt,
    created_by_discord_user_id: role.createdByDiscordUserId,
    updated_by_discord_user_id: role.updatedByDiscordUserId,
  })),
  capabilityRows: snapshot.catalog.map((entry) => ({
    key: entry.key,
    display_name: entry.displayName,
    description: entry.description,
    category: entry.category,
    included_actions: entry.includedActions,
    excluded_actions: entry.excludedActions,
    risk_level: entry.riskLevel,
    assignable_to_non_admin: entry.assignableToNonAdmin,
    is_active: entry.isActive,
    implementation_version: entry.implementationVersion,
    definition_hash: entry.definitionHash,
    deprecated_at: entry.deprecatedAt,
  })),
  grantRows: snapshot.grants.map((grant) => ({
    role_key: grant.roleKey,
    capability_key: grant.capabilityKey,
    granted_at: grant.grantedAt,
    granted_by_discord_user_id: grant.grantedByDiscordUserId,
    grant_reason: grant.grantReason,
  })),
  memberRows: snapshot.members.map((member) => ({
    discord_user_id: member.discordUserId,
    discord_username: member.discordUsername,
    role: member.role,
  })),
  auditRows: [],
  currentAdminDiscordUserId: adminMember.discordUserId,
});
assert.deepEqual(
  roleReadModel.capabilities.map((entry) => entry.key).sort(),
  [...REGISTERED_TEAM_CAPABILITY_KEYS].sort()
);
const draftFingerprint = permissionSnapshotFingerprint(
  roleReadModel.roles,
  roleReadModel.capabilities
);
for (const stagedKey of expectedStagedCapabilityKeys) {
  assert.equal(draftFingerprint.includes(stagedKey), false);
}

console.log(
  JSON.stringify({
    devProjectValidated: true,
    transactionReadOnly: true,
    roles: snapshot.roles.length,
    catalogEntries: snapshot.catalog.length,
    stagedTombstones: expectedStagedCapabilityKeys.length,
    grants: snapshot.grants.length,
    adminGrants: 0,
    seedRoleShadowMatches: shadowMatchCount,
    teamAreaVisible: trialNavigation.length > 0,
    accountTeamAreaLinkVisible: true,
    rolesPermissionBlocks: roleReadModel.capabilities.length,
    draftCapabilityKeys: roleReadModel.capabilities.length,
    memberRoleCounts: snapshot.memberRoleCounts,
  })
);
