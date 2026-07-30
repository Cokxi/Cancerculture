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
  "create_team_role(text,text,text,integer,text,uuid)",
  "set_team_member_admin_role(text,text,boolean,text,text,text,uuid)",
  "set_team_member_non_admin_role(text,text,text,text,text,uuid)",
  "set_team_member_role(text,text,text,text)",
  "set_team_role_active(text,text,boolean,bigint,text,uuid)",
  "set_team_role_capability(text,text,text,boolean,bigint,integer,text,text,uuid)",
  "update_team_role(text,text,text,text,integer,bigint,text,uuid)",
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
                'create_team_role',
                'update_team_role',
                'set_team_role_active',
                'set_team_role_capability',
                'set_team_member_non_admin_role',
                'set_team_member_admin_role',
                'set_team_member_role'
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
                select jsonb_agg(
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
                )
                from aclexplode(
                  coalesce(
                    class_row.relacl,
                    acldefault('r', class_row.relowner)
                  )
                ) acl_row
                left join pg_roles grantee_role
                  on grantee_role.oid = acl_row.grantee
              ) as grants
            from pg_class class_row
            join pg_namespace namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = 'public'
              and class_row.relname in (
                'team_roles',
                'capability_catalog',
                'team_role_capabilities',
                'team_authorization_audit'
              )
          ) table_rows
        ),
      'requestHash',
        (
          select jsonb_build_object(
            'nullable', column_row.is_nullable,
            'type', column_row.data_type,
            'constraint',
              (
                select pg_get_constraintdef(
                  constraint_row.oid,
                  true
                )
                from pg_constraint constraint_row
                where constraint_row.conrelid =
                    'public.team_authorization_audit'::regclass
                  and constraint_row.conname =
                    'team_authorization_audit_request_hash_check'
              )
          )
          from information_schema.columns column_row
          where column_row.table_schema = 'public'
            and column_row.table_name =
              'team_authorization_audit'
            and column_row.column_name = 'request_hash'
        ),
      'persistentState',
        jsonb_build_object(
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
          'admins',
            (
              select count(*)
              from public.team_members
              where role = 'admin'
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
      "The read-only DEV mutation ACL query failed."
    );
  }

  const jsonLine = execution.stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith("{"));

  if (!jsonLine) {
    throw new Error(
      "The read-only DEV mutation ACL query returned no snapshot."
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
    /'reason', v_reason/u
  );
  assert.match(
    functionRow.definition,
    /v_reason is null/u
  );
  assert.doesNotMatch(
    functionRow.definition,
    /\bexecute\s+format\s*\(/iu
  );
}

assert.match(
  snapshot.functions.find(
    (entry) =>
      entry.signature.startsWith(
        "set_team_role_capability("
      )
  ).definition,
  /v_expected_hash is null/u
);

assert.equal(snapshot.tables.length, 4);
for (const tableRow of snapshot.tables) {
  assert.equal(tableRow.rls, true);
  assert.deepEqual(
    tableRow.grants.filter(
      (grant) => grant.grantee === "service_role"
    ),
    [{ grantee: "service_role", privilege: "SELECT" }]
  );
  assert.equal(
    tableRow.grants.some((grant) =>
      ["PUBLIC", "anon", "authenticated", "discord_bot"].includes(
        grant.grantee
      )
    ),
    false
  );
}

assert.deepEqual(snapshot.requestHash, {
  constraint:
    "CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)",
  nullable: "NO",
  type: "text",
});
assert.deepEqual(snapshot.persistentState, {
  adminGrants: 0,
  admins: 1,
  audit: 0,
  catalog: 3,
  grants: 9,
  roles: 4,
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
    tables: snapshot.tables.map((entry) => ({
      name: entry.name,
      rls: entry.rls,
      serviceRolePrivileges: entry.grants
        .filter((grant) => grant.grantee === "service_role")
        .map((grant) => grant.privilege),
    })),
    persistentState: snapshot.persistentState,
  })
);
