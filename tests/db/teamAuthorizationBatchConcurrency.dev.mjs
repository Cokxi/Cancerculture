import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const globalMutationLock =
  "public.team_authorization.mutations";
const testKeys = [
  "50000000-0000-0000-0000-000000000001",
  "50000000-0000-0000-0000-000000000002",
  "50000000-0000-0000-0000-000000000003",
  "50000000-0000-0000-0000-000000000004",
  "50000000-0000-0000-0000-000000000005",
  "50000000-0000-0000-0000-000000000006",
  "50000000-0000-0000-0000-000000000007",
  "50000000-0000-0000-0000-000000000008",
  "50000000-0000-0000-0000-000000000009",
  "50000000-0000-0000-0000-000000000010",
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function baseEnvironment(readOnly = false) {
  return {
    ...process.env,
    PGCONNECT_TIMEOUT: "5",
    PGSSLMODE: "require",
    ...(readOnly
      ? { PGOPTIONS: "-c default_transaction_read_only=on" }
      : {}),
  };
}

function runPsql(databaseUrl, sql, { readOnly = false } = {}) {
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
      env: baseEnvironment(readOnly),
    }
  );

  if (execution.error || execution.status !== 0) {
    throw new Error(
      `The DEV batch concurrency helper failed: ${
        execution.stderr.trim() || "unknown psql failure"
      }`
    );
  }

  return execution.stdout.trim();
}

function spawnPsql(databaseUrl, sql) {
  const child = spawn(
    psql,
    [
      databaseUrl,
      "-X",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--command",
      sql,
    ],
    {
      cwd: repoRoot,
      windowsHide: true,
      env: baseEnvironment(),
    }
  );
  let stdout = "";
  let stderr = "";
  const completion = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });

  return { child, completion };
}

async function waitUntilLockIsHeld(databaseUrl, lockName) {
  const lockExpression = `hashtextextended(
    ${sqlLiteral(lockName)},
    0
  )`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = runPsql(
      databaseUrl,
      `
        begin read only;
        select case
          when pg_try_advisory_lock(${lockExpression})
            then (
              select 'free'
              from pg_advisory_unlock(${lockExpression})
            )
          else 'blocked'
        end;
        rollback;
      `,
      { readOnly: true }
    );

    if (state.includes("blocked")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for advisory lock ${lockName}.`
  );
}

async function assertSerialized({
  databaseUrl,
  lockName,
  holderSql,
  contenderSql,
}) {
  const holder = spawnPsql(databaseUrl, holderSql);
  await waitUntilLockIsHeld(databaseUrl, lockName);
  const contender = spawnPsql(databaseUrl, contenderSql);
  const contenderResult = await contender.completion;
  const holderResult = await holder.completion;

  assert.equal(holderResult.status, 0, holderResult.stderr);
  assert.notEqual(contenderResult.status, 0);
  assert.match(
    contenderResult.stderr,
    /canceling statement due to lock timeout/u
  );
  assert.doesNotMatch(holderResult.stderr, /deadlock detected/iu);
  assert.doesNotMatch(contenderResult.stderr, /deadlock detected/iu);
}

function batchCall({
  actor,
  role,
  capability,
  desired,
  reason,
  key,
}) {
  const roles = JSON.stringify([
    {
      role_key: role.key,
      expected_row_version: role.rowVersion,
    },
  ]);
  const capabilities = JSON.stringify([
    {
      capability_key: capability.key,
      expected_implementation_version:
        capability.implementationVersion,
      expected_definition_hash: capability.definitionHash,
    },
  ]);
  const changes = JSON.stringify([
    {
      role_key: role.key,
      capability_key: capability.key,
      desired_granted: desired,
    },
  ]);

  return `select public.apply_team_role_capability_changes(
    ${sqlLiteral(actor)},
    ${sqlLiteral(roles)}::jsonb,
    ${sqlLiteral(capabilities)}::jsonb,
    ${sqlLiteral(changes)}::jsonb,
    ${sqlLiteral(reason)},
    ${sqlLiteral(key)}::uuid
  );`;
}

function transactionSql(call, { hold = false } = {}) {
  return `
    begin;
    set local lock_timeout = '5s';
    set local statement_timeout = '8s';
    set local role service_role;
    ${call}
    ${hold ? "select pg_sleep(2);" : ""}
    rollback;
  `;
}

function contenderSql(call) {
  return `
    begin;
    set local lock_timeout = '400ms';
    set local statement_timeout = '2s';
    set local role service_role;
    ${call}
    rollback;
  `;
}

function stateFingerprint(databaseUrl) {
  return JSON.parse(
    runPsql(
      databaseUrl,
      `
        begin read only;
        select jsonb_build_object(
          'roles',
            (
              select md5(coalesce(string_agg(
                to_jsonb(role_row)::text,
                '|'
                order by role_row.key
              ), ''))
              from public.team_roles role_row
            ),
          'grants',
            (
              select md5(coalesce(string_agg(
                to_jsonb(grant_row)::text,
                '|'
                order by
                  grant_row.role_key,
                  grant_row.capability_key
              ), ''))
              from public.team_role_capabilities grant_row
            ),
          'auditCount',
            (
              select count(*)
              from public.team_authorization_audit
            ),
          'batchCount',
            (
              select count(*)
              from public.team_authorization_batches
            ),
          'testLedger',
            (
              select count(*)
              from public.team_authorization_batches
              where idempotency_key::text like
                '50000000-0000-0000-0000-%'
            ),
          'testAudit',
            (
              select count(*)
              from public.team_authorization_audit
              where request_id in (
                select batch_id::text
                from public.team_authorization_batches
                where idempotency_key::text like
                  '50000000-0000-0000-0000-%'
              )
            )
        );
        rollback;
      `,
      { readOnly: true }
    )
  );
}

const databaseUrl = await readDevDatabaseUrl();

if (!databaseUrl.includes(approvedDevProjectRef)) {
  throw new Error(
    "Refusing to query a database other than the approved DEV project."
  );
}

const context = JSON.parse(
  runPsql(
    databaseUrl,
    `
      begin read only;
      select jsonb_build_object(
        'actor',
          (
            select discord_user_id
            from public.team_members
            where role = 'admin'
            order by discord_user_id
            limit 1
          ),
        'roles',
          (
            select jsonb_object_agg(
              role_row.key,
              jsonb_build_object(
                'key', role_row.key,
                'rowVersion', role_row.row_version,
                'displayName', role_row.display_name,
                'description', role_row.description,
                'sortOrder', role_row.sort_order
              )
            )
            from public.team_roles role_row
            where role_row.key in (
              'trial_moderator',
              'moderator',
              'super_moderator'
            )
          ),
        'capabilities',
          (
            select jsonb_object_agg(
              capability_row.key,
              jsonb_build_object(
                'key', capability_row.key,
                'implementationVersion',
                  capability_row.implementation_version,
                'definitionHash',
                  capability_row.definition_hash
              )
            )
            from public.capability_catalog capability_row
          ),
        'testKeyCollisions',
          (
            select
              (
                select count(*)
                from public.team_authorization_batches
                where idempotency_key = any(
                  array[
                    ${testKeys
                      .map((key) => `${sqlLiteral(key)}::uuid`)
                      .join(",")}
                  ]::uuid[]
                )
              )
              +
              (
                select count(*)
                from public.team_authorization_audit
                where idempotency_key = any(
                  array[
                    ${testKeys
                      .map((key) => `${sqlLiteral(key)}::uuid`)
                      .join(",")}
                  ]::uuid[]
                )
              )
          )
      );
      rollback;
    `,
    { readOnly: true }
  )
);

assert.ok(context.actor);
assert.equal(context.testKeyCollisions, 0);

const roles = context.roles;
const capabilities = context.capabilities;
const flag = capabilities["users.flag"];
const directory =
  capabilities["users.directory.basic.view"];
const submission =
  capabilities["submissions.submission_phase.moderate"];
const before = stateFingerprint(databaseUrl);

const identicalCall = batchCall({
  actor: context.actor,
  role: roles.trial_moderator,
  capability: flag,
  desired: false,
  reason: "Rollback parallel identical batch",
  key: testKeys[0],
});
await assertSerialized({
  databaseUrl,
  lockName: testKeys[0],
  holderSql: transactionSql(identicalCall, { hold: true }),
  contenderSql: contenderSql(identicalCall),
});

await assertSerialized({
  databaseUrl,
  lockName: testKeys[1],
  holderSql: transactionSql(
    batchCall({
      actor: context.actor,
      role: roles.trial_moderator,
      capability: flag,
      desired: false,
      reason: "Rollback same key holder payload",
      key: testKeys[1],
    }),
    { hold: true }
  ),
  contenderSql: contenderSql(
    batchCall({
      actor: context.actor,
      role: roles.trial_moderator,
      capability: flag,
      desired: true,
      reason: "Rollback different contender payload",
      key: testKeys[1],
    })
  ),
});

await assertSerialized({
  databaseUrl,
  lockName: globalMutationLock,
  holderSql: transactionSql(
    batchCall({
      actor: context.actor,
      role: roles.trial_moderator,
      capability: flag,
      desired: false,
      reason: "Rollback overlapping batch holder",
      key: testKeys[2],
    }),
    { hold: true }
  ),
  contenderSql: contenderSql(
    batchCall({
      actor: context.actor,
      role: roles.trial_moderator,
      capability: directory,
      desired: false,
      reason: "Rollback overlapping batch contender",
      key: testKeys[3],
    })
  ),
});

await assertSerialized({
  databaseUrl,
  lockName: globalMutationLock,
  holderSql: transactionSql(
    batchCall({
      actor: context.actor,
      role: roles.moderator,
      capability: flag,
      desired: false,
      reason: "Rollback batch versus single holder",
      key: testKeys[4],
    }),
    { hold: true }
  ),
  contenderSql: contenderSql(`
    select public.set_team_role_capability(
      ${sqlLiteral(context.actor)},
      ${sqlLiteral(roles.moderator.key)},
      ${sqlLiteral(directory.key)},
      false,
      ${roles.moderator.rowVersion},
      ${directory.implementationVersion},
      ${sqlLiteral(directory.definitionHash)},
      'Rollback single RPC contender',
      ${sqlLiteral(testKeys[5])}::uuid
    );
  `),
});

await assertSerialized({
  databaseUrl,
  lockName: globalMutationLock,
  holderSql: transactionSql(
    batchCall({
      actor: context.actor,
      role: roles.super_moderator,
      capability: submission,
      desired: false,
      reason: "Rollback batch versus activation holder",
      key: testKeys[6],
    }),
    { hold: true }
  ),
  contenderSql: contenderSql(`
    select public.set_team_role_active(
      ${sqlLiteral(context.actor)},
      ${sqlLiteral(roles.super_moderator.key)},
      false,
      ${roles.super_moderator.rowVersion},
      'Rollback activation contender',
      ${sqlLiteral(testKeys[7])}::uuid
    );
  `),
});

await assertSerialized({
  databaseUrl,
  lockName: globalMutationLock,
  holderSql: transactionSql(
    batchCall({
      actor: context.actor,
      role: roles.trial_moderator,
      capability: flag,
      desired: false,
      reason: "Rollback nonoverlap holder",
      key: testKeys[8],
    }),
    { hold: true }
  ),
  contenderSql: contenderSql(
    batchCall({
      actor: context.actor,
      role: roles.moderator,
      capability: directory,
      desired: false,
      reason: "Rollback nonoverlap contender",
      key: testKeys[9],
    })
  ),
});

const after = stateFingerprint(databaseUrl);
assert.deepEqual(after, before);
assert.equal(after.testLedger, 0);
assert.equal(after.testAudit, 0);

console.log(
  JSON.stringify({
    devProjectValidated: true,
    actualConcurrentSessions: true,
    identicalSameKeySerialized: true,
    differentPayloadSameKeySerialized: true,
    overlappingDifferentKeysSerialized: true,
    batchAgainstSingleRpcSerialized: true,
    batchAgainstRoleActivationSerialized: true,
    nonOverlappingBatchesSerializedByGlobalDomain: true,
    deadlocks: 0,
    committedTransactions: 0,
    persistentTestLedger: after.testLedger,
    persistentTestAudit: after.testAudit,
    limitation:
      "Every holder and contender rolls back. Contenders use bounded lock-timeout outcomes to prove lock ordering without leaving immutable audit or ledger rows; sequential rollback tests cover replay, payload conflict, stale snapshots, and exact version effects.",
  })
);
