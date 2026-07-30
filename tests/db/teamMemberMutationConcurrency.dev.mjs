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
const concurrencyKeys = [
  "30000000-0000-0000-0000-000000000001",
  "30000000-0000-0000-0000-000000000002",
  "30000000-0000-0000-0000-000000000003",
  "30000000-0000-0000-0000-000000000004",
  "30000000-0000-0000-0000-000000000005",
  "30000000-0000-0000-0000-000000000006",
  "30000000-0000-0000-0000-000000000007",
];
const syntheticTargetId = "99999999999999011";
const syntheticTargetUsername = "rollback-concurrency-target";

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
  return `'${value.replaceAll("'", "''")}'`;
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
      maxBuffer: 1_000_000,
      encoding: "utf8",
      env: baseEnvironment(readOnly),
    }
  );

  if (execution.error || execution.status !== 0) {
    throw new Error("The DEV concurrency helper query failed.");
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
        'actorId',
          (
            select discord_user_id
            from public.team_members
            where role = 'admin'
              and discord_user_id ~ '^[0-9]{5,32}$'
            order by discord_user_id
            limit 1
          ),
        'syntheticCollisions',
          (
            select
              (select count(*) from public.team_members
                where discord_user_id = ${sqlLiteral(syntheticTargetId)})
              +
              (select count(*) from public.user_logs
                where discord_user_id = ${sqlLiteral(syntheticTargetId)})
              +
              (select count(*) from public.discord_member_state
                where discord_user_id = ${sqlLiteral(syntheticTargetId)})
          )
      );
      rollback;
    `,
    { readOnly: true }
  )
);

assert.match(context.actorId, /^[0-9]{5,32}$/u);
assert.equal(context.syntheticCollisions, 0);

const actor = sqlLiteral(context.actorId);
const target = sqlLiteral(syntheticTargetId);
const username = sqlLiteral(syntheticTargetUsername);
const [
  addKey,
  addContenderKey,
  retryKey,
  removeKey,
  removeContenderKey,
  roleChangeKey,
  roleRemoveKey,
] = concurrencyKeys.map(
  (key) => `${sqlLiteral(key)}::uuid`
);

try {
  runPsql(
    databaseUrl,
    `
      insert into public.discord_member_state (
        discord_user_id,
        current_discord_username
      )
      values (${target}, ${username});
    `
  );

  await assertSerialized({
    databaseUrl,
    lockName:
      `public.team_authorization.member:${syntheticTargetId}`,
    holderSql: `
      begin;
      set local statement_timeout = '8s';
      set local role service_role;
      select public.add_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        true,
        'Rollback concurrent add holder',
        ${addKey}
      );
      select pg_sleep(3);
      rollback;
    `,
    contenderSql: `
      begin;
      set local lock_timeout = '400ms';
      set local statement_timeout = '2s';
      set local role service_role;
      select public.add_team_member(
        ${actor},
        ${target},
        'moderator',
        true,
        'Rollback concurrent add contender',
        ${addContenderKey}
      );
      rollback;
    `,
  });

  await assertSerialized({
    databaseUrl,
    lockName:
      `public.team_authorization.member:${syntheticTargetId}`,
    holderSql: `
      begin;
      set local statement_timeout = '8s';
      set local role service_role;
      select public.add_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        true,
        'Rollback identical retry holder',
        ${retryKey}
      );
      select pg_sleep(3);
      rollback;
    `,
    contenderSql: `
      begin;
      set local lock_timeout = '400ms';
      set local statement_timeout = '2s';
      set local role service_role;
      select public.add_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        true,
        'Rollback identical retry holder',
        ${retryKey}
      );
      rollback;
    `,
  });

  runPsql(
    databaseUrl,
    `
      insert into public.team_members (
        discord_user_id,
        discord_username,
        role
      )
      values (
        ${target},
        ${username},
        'trial_moderator'
      );
    `
  );

  await assertSerialized({
    databaseUrl,
    lockName:
      `public.team_authorization.member:${syntheticTargetId}`,
    holderSql: `
      begin;
      set local statement_timeout = '8s';
      set local role service_role;
      select public.remove_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        'Rollback concurrent remove holder',
        ${removeKey}
      );
      select pg_sleep(3);
      rollback;
    `,
    contenderSql: `
      begin;
      set local lock_timeout = '400ms';
      set local statement_timeout = '2s';
      set local role service_role;
      select public.remove_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        'Rollback concurrent remove contender',
        ${removeContenderKey}
      );
      rollback;
    `,
  });

  await assertSerialized({
    databaseUrl,
    lockName: "public.team_authorization.mutations",
    holderSql: `
      begin;
      set local statement_timeout = '8s';
      set local role service_role;
      select public.set_team_member_non_admin_role(
        ${actor},
        ${target},
        'moderator',
        'trial_moderator',
        'Rollback role change versus remove',
        ${roleChangeKey}
      );
      select pg_sleep(3);
      rollback;
    `,
    contenderSql: `
      begin;
      set local lock_timeout = '400ms';
      set local statement_timeout = '2s';
      set local role service_role;
      select public.remove_team_member(
        ${actor},
        ${target},
        'trial_moderator',
        'Rollback remove versus role change',
        ${roleRemoveKey}
      );
      rollback;
    `,
  });
} finally {
  runPsql(
    databaseUrl,
    `
      delete from public.team_members
      where discord_user_id = ${target};
      delete from public.discord_member_state
      where discord_user_id = ${target};
    `
  );
}

const finalState = JSON.parse(
  runPsql(
    databaseUrl,
    `
      begin read only;
      select jsonb_build_object(
        'targetMembers',
          (
            select count(*)
            from public.team_members
            where discord_user_id = ${target}
          ),
        'testAudit',
          (
            select count(*)
            from public.team_authorization_audit
            where idempotency_key = any(
              array[
                ${concurrencyKeys
                  .map((key) => `${sqlLiteral(key)}::uuid`)
                  .join(",")}
              ]::uuid[]
            )
          ),
        'targetIdentities',
          (
            select count(*)
            from public.discord_member_state
            where discord_user_id = ${target}
          )
      );
      rollback;
    `,
    { readOnly: true }
  )
);

assert.deepEqual(finalState, {
  targetMembers: 0,
  testAudit: 0,
  targetIdentities: 0,
});

console.log(
  JSON.stringify({
    devProjectValidated: true,
    actualConcurrentSessions: true,
    parallelAddsSerialized: true,
    parallelIdenticalRetriesSerialized: true,
    parallelRemovesSerialized: true,
    removeAgainstRoleChangeSerialized: true,
    deadlocks: 0,
    persistentTestMembers: finalState.targetMembers,
    persistentTestAudit: finalState.testAudit,
    limitation:
      "Contenders use bounded lock-timeout outcomes because committing a winner would leave immutable audit test data; sequential rollback tests cover committed-shape replay semantics.",
  })
);
