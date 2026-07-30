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
                'isActive', is_active
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
                'isActive', is_active,
                'assignableToNonAdmin',
                  assignable_to_non_admin,
                'implementationVersion',
                  implementation_version,
                'definitionHash', definition_hash
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
                'capabilityKey', capability_key
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

const [
  {
    REGISTERED_TEAM_CAPABILITY_KEYS,
    TEAM_CAPABILITY_REGISTRY,
  },
  { resolveDynamicTeamAuthorizationSnapshot },
  { compareTeamAuthorizationShadow },
] = await Promise.all([
  import("../../lib/auth/teamCapabilityRegistry.ts"),
  import("../../lib/auth/dynamicTeamAuthorization.ts"),
  import("../../lib/auth/teamAuthorizationShadow.ts"),
]);
const snapshot = readFoundationSnapshot(databaseUrl);
const expectedRoles = [
  "admin",
  "moderator",
  "super_moderator",
  "trial_moderator",
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
  [...REGISTERED_TEAM_CAPABILITY_KEYS].sort()
);

for (const entry of snapshot.catalog) {
  const registered = TEAM_CAPABILITY_REGISTRY[entry.key];

  assert.ok(registered);
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
}

assert.equal(snapshot.grants.length, 9);
assert.equal(
  snapshot.grants.some(
    (grant) => grant.roleKey === "admin"
  ),
  false
);

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
  assert.equal(shadow.isMatch, true);

  if (roleKey === "admin") {
    assert.equal(dynamicResult.isAdmin, true);
    assert.deepEqual(
      dynamicResult.resolvedCapabilities,
      []
    );
  } else {
    assert.equal(dynamicResult.isAdmin, false);
    assert.deepEqual(
      dynamicResult.resolvedCapabilities,
      REGISTERED_TEAM_CAPABILITY_KEYS
    );
    assert.equal(
      snapshot.grants.filter(
        (grant) => grant.roleKey === roleKey
      ).length,
      3
    );
  }
}

console.log(
  JSON.stringify({
    devProjectValidated: true,
    transactionReadOnly: true,
    roles: snapshot.roles.length,
    catalogEntries: snapshot.catalog.length,
    grants: snapshot.grants.length,
    adminGrants: 0,
    seedRoleShadowMatches: expectedRoles.length,
    memberRoleCounts: snapshot.memberRoleCounts,
  })
);
