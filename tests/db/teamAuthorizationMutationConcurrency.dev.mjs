import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const adminPopulationLock =
  "public.team_authorization.admin_population";

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
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: "5",
        PGSSLMODE: "require",
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
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

  return {
    child,
    completion,
    output: () => ({ stderr, stdout }),
  };
}

async function waitUntilLockIsHeld(databaseUrl, lockExpression) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const observer = spawnPsql(
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
      `
    );
    const result = await observer.completion;

    if (result.status !== 0) {
      throw new Error(
        "The read-only advisory-lock observer failed."
      );
    }
    if (result.stdout.includes("blocked")) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    "Timed out waiting for the advisory lock holder."
  );
}

const databaseUrl = await readDevDatabaseUrl();

if (!databaseUrl.includes(approvedDevProjectRef)) {
  throw new Error(
    "Refusing to query a database other than the approved DEV project."
  );
}

const lockExpression = `hashtextextended(${sqlLiteral(
  adminPopulationLock
)}, 0)`;
const holder = spawnPsql(
  databaseUrl,
  `
    begin read only;
    set local statement_timeout = '5s';
    select pg_advisory_xact_lock(${lockExpression});
    select pg_sleep(4);
    rollback;
  `
);

await waitUntilLockIsHeld(databaseUrl, lockExpression);

const contender = spawnPsql(
  databaseUrl,
  `
    begin read only;
    set local lock_timeout = '400ms';
    set local statement_timeout = '2s';
    select pg_advisory_xact_lock(${lockExpression});
    rollback;
  `
);
const contenderResult = await contender.completion;
const holderResult = await holder.completion;

assert.equal(holderResult.status, 0);
assert.notEqual(contenderResult.status, 0);
assert.match(
  contenderResult.stderr,
  /canceling statement due to lock timeout/u
);

console.log(
  JSON.stringify({
    devProjectValidated: true,
    transactionsReadOnly: true,
    adminPopulationLockSerialized: true,
    contenderTimedOutWhileHolderOwnedLock: true,
    persistentMutations: 0,
  })
);
