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
const expectedSignature =
  "apply_team_role_capability_changes(text,jsonb,jsonb,jsonb,text,uuid)";
const expectedColumns = [
  ["batch_id", "uuid", "NO"],
  ["idempotency_key", "uuid", "NO"],
  ["actor_discord_user_id", "text", "NO"],
  ["request_hash", "text", "NO"],
  ["request_payload", "jsonb", "NO"],
  ["result", "jsonb", "NO"],
  ["reason", "text", "NO"],
  ["operation_version", "integer", "NO"],
  ["submitted_pair_count", "integer", "NO"],
  ["changed_pair_count", "integer", "NO"],
  ["noop_pair_count", "integer", "NO"],
  ["grant_count", "integer", "NO"],
  ["revoke_count", "integer", "NO"],
  ["affected_role_count", "integer", "NO"],
  ["created_at", "timestamp with time zone", "NO"],
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
      'function',
        (
          select jsonb_build_object(
            'signature', function_row.oid::regprocedure::text,
            'owner', pg_get_userbyid(function_row.proowner),
            'securityDefiner', function_row.prosecdef,
            'config', coalesce(
              array_to_string(function_row.proconfig, ','),
              ''
            ),
            'executeGrantees',
              (
                select jsonb_agg(name order by name)
                from (
                  select distinct
                    case
                      when acl_row.grantee = 0 then 'PUBLIC'
                      else grantee_role.rolname
                    end as name
                  from aclexplode(
                    coalesce(
                      function_row.proacl,
                      acldefault('f', function_row.proowner)
                    )
                  ) acl_row
                  left join pg_roles grantee_role
                    on grantee_role.oid = acl_row.grantee
                  where acl_row.privilege_type = 'EXECUTE'
                ) grantees
              ),
            'definition', pg_get_functiondef(function_row.oid)
          )
          from pg_proc function_row
          join pg_namespace namespace_row
            on namespace_row.oid = function_row.pronamespace
          where namespace_row.nspname = 'public'
            and function_row.proname =
              'apply_team_role_capability_changes'
        ),
      'overloadCount',
        (
          select count(*)
          from pg_proc function_row
          join pg_namespace namespace_row
            on namespace_row.oid = function_row.pronamespace
          where namespace_row.nspname = 'public'
            and function_row.proname =
              'apply_team_role_capability_changes'
        ),
      'table',
        (
          select jsonb_build_object(
            'owner', pg_get_userbyid(class_row.relowner),
            'rls', class_row.relrowsecurity,
            'grants',
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'grantee',
                      case
                        when acl_row.grantee = 0 then 'PUBLIC'
                        else grantee_role.rolname
                      end,
                    'privilege', acl_row.privilege_type
                  )
                  order by
                    case
                      when acl_row.grantee = 0 then 'PUBLIC'
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
              )
          )
          from pg_class class_row
          where class_row.oid =
            'public.team_authorization_batches'::regclass
        ),
      'columns',
        (
          select jsonb_agg(
            jsonb_build_array(
              column_name,
              data_type,
              is_nullable
            )
            order by ordinal_position
          )
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'team_authorization_batches'
        ),
      'constraints',
        (
          select jsonb_object_agg(
            constraint_row.conname,
            pg_get_constraintdef(constraint_row.oid, true)
          )
          from pg_constraint constraint_row
          where constraint_row.conrelid =
            'public.team_authorization_batches'::regclass
        ),
      'trigger',
        (
          select jsonb_build_object(
            'enabled', trigger_row.tgenabled,
            'definition',
              pg_get_triggerdef(trigger_row.oid, true),
            'functionOwner',
              pg_get_userbyid(function_row.proowner),
            'executeGrantees',
              (
                select jsonb_agg(name order by name)
                from (
                  select distinct
                    case
                      when acl_row.grantee = 0 then 'PUBLIC'
                      else grantee_role.rolname
                    end as name
                  from aclexplode(
                    coalesce(
                      function_row.proacl,
                      acldefault('f', function_row.proowner)
                    )
                  ) acl_row
                  left join pg_roles grantee_role
                    on grantee_role.oid = acl_row.grantee
                  where acl_row.privilege_type = 'EXECUTE'
                ) trigger_grantees
              )
          )
          from pg_trigger trigger_row
          join pg_proc function_row
            on function_row.oid = trigger_row.tgfoid
          where trigger_row.tgrelid =
              'public.team_authorization_batches'::regclass
            and trigger_row.tgname =
              'protect_team_authorization_batches'
        ),
      'auditCorrelation',
        (
          select jsonb_build_object(
            'type', column_row.data_type,
            'nullable', column_row.is_nullable,
            'indexPresent',
              to_regclass(
                'public.team_authorization_audit_request_id_idx'
              ) is not null
          )
          from information_schema.columns column_row
          where column_row.table_schema = 'public'
            and column_row.table_name =
              'team_authorization_audit'
            and column_row.column_name = 'request_id'
        ),
      'persistentState',
        jsonb_build_object(
          'batches',
            (
              select count(*)
              from public.team_authorization_batches
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
          'members', (select count(*) from public.team_members),
          'admins',
            (
              select count(*)
              from public.team_members
              where role = 'admin'
            ),
          'audit',
            (
              select count(*)
              from public.team_authorization_audit
            ),
          'correlatedAudit',
            (
              select count(*)
              from public.team_authorization_audit
              where request_id is not null
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
      `The read-only DEV batch ACL query failed: ${
        execution.stderr.trim() || "unknown psql failure"
      }`
    );
  }

  const jsonLine = execution.stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) {
    throw new Error(
      "The read-only DEV batch ACL query returned no snapshot."
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
assert.equal(snapshot.overloadCount, 1);
assert.equal(snapshot.function.signature, expectedSignature);
assert.equal(snapshot.function.owner, "postgres");
assert.equal(snapshot.function.securityDefiner, true);
assert.equal(
  snapshot.function.config,
  "search_path=public, pg_temp"
);
assert.deepEqual(
  snapshot.function.executeGrantees,
  ["postgres", "service_role"]
);
assert.match(
  snapshot.function.definition,
  /public\.team_authorization\.mutations/u
);
assert.match(
  snapshot.function.definition,
  /hashtextextended\(p_idempotency_key::text, 0\)/u
);
assert.doesNotMatch(
  snapshot.function.definition,
  /\bexecute\s+format\s*\(/iu
);

assert.equal(snapshot.table.owner, "postgres");
assert.equal(snapshot.table.rls, true);
assert.deepEqual(
  snapshot.table.grants.filter(
    (grant) => grant.grantee === "service_role"
  ),
  [{ grantee: "service_role", privilege: "SELECT" }]
);
assert.equal(
  snapshot.table.grants.some((grant) =>
    ["PUBLIC", "anon", "authenticated", "discord_bot"].includes(
      grant.grantee
    )
  ),
  false
);
assert.deepEqual(snapshot.columns, expectedColumns);
for (const requiredConstraint of [
  "team_authorization_batches_pkey",
  "team_authorization_batches_idempotency_key_key",
  "team_authorization_batches_request_hash_check",
  "team_authorization_batches_counts_check",
]) {
  assert.equal(
    typeof snapshot.constraints[requiredConstraint],
    "string"
  );
}
assert.equal(snapshot.trigger.enabled, "O");
assert.match(
  snapshot.trigger.definition,
  /BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE) ON team_authorization_batches/u
);
assert.equal(snapshot.trigger.functionOwner, "postgres");
assert.deepEqual(
  snapshot.trigger.executeGrantees,
  ["postgres"]
);
assert.deepEqual(snapshot.auditCorrelation, {
  indexPresent: true,
  nullable: "YES",
  type: "text",
});
assert.deepEqual(snapshot.persistentState, {
  adminGrants: 0,
  admins: 1,
  audit: 4,
  batches: 0,
  catalog: 3,
  correlatedAudit: 0,
  grants: 9,
  members: 1,
  roles: 4,
});

console.log(
  JSON.stringify({
    devProjectValidated: true,
    transactionReadOnly: true,
    function: {
      signature: snapshot.function.signature,
      owner: snapshot.function.owner,
      securityDefiner: snapshot.function.securityDefiner,
      searchPath: snapshot.function.config,
      executeGrantees: snapshot.function.executeGrantees,
    },
    ledger: {
      owner: snapshot.table.owner,
      rls: snapshot.table.rls,
      serviceRolePrivileges: snapshot.table.grants
        .filter((grant) => grant.grantee === "service_role")
        .map((grant) => grant.privilege),
      appendOnlyTrigger: true,
    },
    auditCorrelation: snapshot.auditCorrelation,
    persistentState: snapshot.persistentState,
  })
);
