import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const approvedDevProjectRef = "gceljiuydyiwkomymuqh";
const psql =
  process.env.PSQL_BIN ??
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const expectedSignatures = [
  "add_team_member(text,text,text,boolean,text,uuid)",
  "remove_team_member(text,text,text,text,uuid)",
];
const fullLegacyServiceRolePrivileges = [
  "DELETE",
  "INSERT",
  "MAINTAIN",
  "REFERENCES",
  "SELECT",
  "TRIGGER",
  "TRUNCATE",
  "UPDATE",
];

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

function querySnapshot(databaseUrl) {
  const sql = `
    begin read only;
    set local lock_timeout = '3s';
    set local statement_timeout = '15s';

    select jsonb_build_object(
      'transactionReadOnly',
        current_setting('transaction_read_only'),
      'functions',
        (
          select jsonb_agg(
            jsonb_build_object(
              'signature', function_rows.signature,
              'owner', function_rows.owner_name,
              'securityDefiner',
                function_rows.security_definer,
              'config', function_rows.function_config,
              'executeGrantees',
                function_rows.execute_grantees,
              'definition', function_rows.definition
            )
            order by function_rows.signature
          )
          from (
            select
              function_row.oid::regprocedure::text as signature,
              pg_get_userbyid(function_row.proowner)
                as owner_name,
              function_row.prosecdef as security_definer,
              coalesce(
                array_to_string(function_row.proconfig, ','),
                ''
              ) as function_config,
              (
                select jsonb_agg(grantee_name order by grantee_name)
                from (
                  select distinct
                    case
                      when acl_row.grantee = 0 then 'PUBLIC'
                      else grantee_role.rolname
                    end as grantee_name
                  from aclexplode(
                    coalesce(
                      function_row.proacl,
                      acldefault(
                        'f',
                        function_row.proowner
                      )
                    )
                  ) acl_row
                  left join pg_roles grantee_role
                    on grantee_role.oid = acl_row.grantee
                  where acl_row.privilege_type = 'EXECUTE'
                ) grantees
              ) as execute_grantees,
              pg_get_functiondef(function_row.oid)
                as definition
            from pg_proc function_row
            join pg_namespace namespace_row
              on namespace_row.oid =
                function_row.pronamespace
            where namespace_row.nspname = 'public'
              and function_row.proname in (
                'add_team_member',
                'remove_team_member'
              )
          ) function_rows
        ),
      'tables',
        (
          select jsonb_agg(
            jsonb_build_object(
              'name', table_rows.table_name,
              'rls', table_rows.rls,
              'grants', table_rows.grants
            )
            order by table_rows.table_name
          )
          from (
            select
              class_row.relname as table_name,
              class_row.relrowsecurity as rls,
              (
                select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'grantee',
                        case
                          when acl_row.grantee = 0
                            then 'PUBLIC'
                          else grantee_role.rolname
                        end,
                      'privilege', acl_row.privilege_type
                    )
                    order by
                      case
                        when acl_row.grantee = 0
                          then 'PUBLIC'
                        else grantee_role.rolname
                      end,
                      acl_row.privilege_type
                  ),
                  '[]'::jsonb
                )
                from aclexplode(
                  coalesce(
                    class_row.relacl,
                    acldefault('r', class_row.relowner)
                  )
                ) acl_row
                left join pg_roles grantee_role
                  on grantee_role.oid = acl_row.grantee
                where acl_row.grantee <> class_row.relowner
              ) as grants
            from pg_class class_row
            join pg_namespace namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = 'public'
              and class_row.relname in (
                'discord_member_state',
                'team_authorization_audit',
                'team_members',
                'team_roles',
                'user_logs'
              )
          ) table_rows
        ),
      'audit',
        jsonb_build_object(
          'eventConstraint',
            (
              select pg_get_constraintdef(
                constraint_row.oid,
                true
              )
              from pg_constraint constraint_row
              where constraint_row.conrelid =
                  'public.team_authorization_audit'::regclass
                and constraint_row.conname =
                  'team_authorization_audit_event_type_check'
            ),
          'targetConstraint',
            (
              select pg_get_constraintdef(
                constraint_row.oid,
                true
              )
              from pg_constraint constraint_row
              where constraint_row.conrelid =
                  'public.team_authorization_audit'::regclass
                and constraint_row.conname =
                  'team_authorization_audit_target_check'
            ),
          'protectionTrigger',
            (
              select pg_get_triggerdef(trigger_row.oid, true)
              from pg_trigger trigger_row
              where trigger_row.tgrelid =
                  'public.team_authorization_audit'::regclass
                and trigger_row.tgname =
                  'protect_team_authorization_audit'
                and not trigger_row.tgisinternal
            )
        ),
      'persistentState',
        jsonb_build_object(
          'members',
            (select count(*) from public.team_members),
          'admins',
            (
              select count(*)
              from public.team_members
              where role = 'admin'
            ),
          'roles', (select count(*) from public.team_roles),
          'catalog',
            (select count(*) from public.capability_catalog),
          'grants',
            (
              select count(*)
              from public.team_role_capabilities
            ),
          'adminGrants',
            (
              select count(*)
              from public.team_role_capabilities
              where role_key = 'admin'
            ),
          'audit',
            (
              select count(*)
              from public.team_authorization_audit
            ),
          'testMembers',
            (
              select count(*)
              from public.team_members
              where discord_user_id like '99999999999999%'
            ),
          'testAudit',
            (
              select count(*)
              from public.team_authorization_audit
              where idempotency_key::text like
                '20000000-0000-0000-0000-%'
            ),
          'testRoles',
            (
              select count(*)
              from public.team_roles
              where key like 'custom_member_test_%'
            ),
          'roleFingerprint',
            (
              select md5(
                string_agg(
                  key || ':' || display_name || ':' ||
                    is_active::text || ':' ||
                    row_version::text,
                  '|' order by key
                )
              )
              from public.team_roles
            ),
          'grantFingerprint',
            (
              select md5(
                string_agg(
                  role_key || ':' || capability_key,
                  '|' order by role_key, capability_key
                )
              )
              from public.team_role_capabilities
            ),
          'catalogFingerprint',
            (
              select md5(
                string_agg(
                  key || ':' ||
                    implementation_version::text || ':' ||
                    definition_hash,
                  '|' order by key
                )
              )
              from public.capability_catalog
            )
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
      maxBuffer: 2_000_000,
      encoding: "utf8",
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: "5",
        PGSSLMODE: "require",
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
    }
  );

  if (execution.error || execution.status !== 0) {
    throw new Error(
      "The read-only DEV member mutation ACL query failed."
    );
  }

  const jsonLine = execution.stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith("{"));

  if (!jsonLine) {
    throw new Error(
      "The read-only DEV member mutation query returned no snapshot."
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

const snapshot = querySnapshot(databaseUrl);

assert.equal(snapshot.transactionReadOnly, "on");
assert.deepEqual(
  snapshot.functions.map((entry) => entry.signature),
  expectedSignatures
);

for (const functionRow of snapshot.functions) {
  assert.equal(functionRow.owner, "postgres");
  assert.equal(functionRow.securityDefiner, true);
  assert.equal(
    functionRow.config,
    "search_path=public, pg_temp"
  );
  assert.deepEqual(
    functionRow.executeGrantees,
    ["postgres", "service_role"]
  );
  assert.match(
    functionRow.definition,
    /public\.team_authorization\.mutations/u
  );
  assert.match(
    functionRow.definition,
    /public\.team_authorization\.member:/u
  );
  assert.match(
    functionRow.definition,
    /where discord_user_id = v_actor_id[\s\S]*for update/u
  );
  assert.match(
    functionRow.definition,
    /TEAM_AUTH_IDEMPOTENCY_CONFLICT/u
  );
  assert.doesNotMatch(
    functionRow.definition,
    /\bexecute\s+format\s*\(/iu
  );
}

assert.deepEqual(
  snapshot.tables.map((entry) => entry.name),
  [
    "discord_member_state",
    "team_authorization_audit",
    "team_members",
    "team_roles",
    "user_logs",
  ]
);

for (const tableRow of snapshot.tables) {
  assert.equal(tableRow.rls, true);
  assert.equal(
    tableRow.grants.some((grant) =>
      ["PUBLIC", "anon", "authenticated", "discord_bot"].includes(
        grant.grantee
      )
    ),
    false
  );

  const serviceRolePrivileges = tableRow.grants
    .filter((grant) => grant.grantee === "service_role")
    .map((grant) => grant.privilege);

  if (
    ["team_authorization_audit", "team_roles"].includes(
      tableRow.name
    )
  ) {
    assert.deepEqual(serviceRolePrivileges, ["SELECT"]);
  } else {
    assert.deepEqual(
      serviceRolePrivileges,
      fullLegacyServiceRolePrivileges
    );
  }
}

assert.match(snapshot.audit.eventConstraint, /member_added/u);
assert.match(snapshot.audit.eventConstraint, /member_removed/u);
assert.match(snapshot.audit.targetConstraint, /member_added/u);
assert.match(snapshot.audit.targetConstraint, /member_removed/u);
assert.match(
  snapshot.audit.protectionTrigger,
  /BEFORE DELETE OR UPDATE/u
);

assert.deepEqual(snapshot.persistentState, {
  adminGrants: 0,
  admins: 1,
  audit: 0,
  catalog: 3,
  catalogFingerprint: "07c3fcfbc0de07123bfe66c947027359",
  grantFingerprint: "a80575db6c3564e209fd910f93cd1254",
  grants: 9,
  members: 1,
  roleFingerprint: "49f24294c36c396457272eecd95bc527",
  roles: 4,
  testAudit: 0,
  testMembers: 0,
  testRoles: 0,
});

console.log(
  JSON.stringify({
    devProjectValidated: true,
    transactionReadOnly: true,
    functions: snapshot.functions.map((entry) => ({
      signature: entry.signature,
      owner: entry.owner,
      securityDefiner: entry.securityDefiner,
      searchPath: entry.config,
      executeGrantees: entry.executeGrantees,
    })),
    tableAclBaselinePreserved: snapshot.tables.map((entry) => ({
      name: entry.name,
      serviceRolePrivileges: entry.grants
        .filter((grant) => grant.grantee === "service_role")
        .map((grant) => grant.privilege),
    })),
    auditAppendOnly: true,
    persistentState: snapshot.persistentState,
  })
);
