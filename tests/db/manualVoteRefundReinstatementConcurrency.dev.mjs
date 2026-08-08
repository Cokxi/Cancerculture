import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const devProjectRef = "gceljiuydyiwkomymuqh";

async function readDevDatabaseUrl() {
  const configured = process.env.SUPABASE_DEV_DATABASE_URL;
  if (configured) {
    if (!configured.includes(devProjectRef)) {
      throw new Error("DEV project reference mismatch.");
    }
    return configured;
  }

  const dotenv = await readFile(
    path.join(repoRoot, ".env.codex.local"),
    "utf8"
  );
  const line = dotenv
    .split(/\r?\n/u)
    .find((candidate) =>
      /^\s*SUPABASE_DEV_DATABASE_URL\s*=/u.test(candidate)
    );
  if (!line) throw new Error("DEV connection variable unavailable.");

  const value = line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/u, "$2");
  if (!value.includes(devProjectRef)) {
    throw new Error("DEV project reference mismatch.");
  }
  return value;
}

function runSql(databaseUrl, sql) {
  const psql =
    process.env.PSQL_BIN ??
    "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `psql exited with code ${code}`));
    });
  });
}

function blockedReinstatementTransaction(submissionId, holdSeconds) {
  return `
    begin;
    set local lock_timeout = '10s';
    set local statement_timeout = '20s';
    select id
    from public.submissions
    where id = ${submissionId}
      and vote_refund_id is not null
      and is_disqualified
    for update;
    select pg_sleep(${holdSeconds});
    do $attempt$
    begin
      begin
        update public.submissions
        set is_disqualified = false
        where id = ${submissionId};
        raise exception 'REFUNDED_SUBMISSION_REINSTATEMENT_ACCEPTED';
      exception when sqlstate 'PT409' then
        if sqlerrm <> 'VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED' then
          raise;
        end if;
      end;
    end;
    $attempt$;
    rollback;
  `;
}

async function main() {
  const databaseUrl = await readDevDatabaseUrl();
  const preflight = await runSql(
    databaseUrl,
    `
      select submission.id::text || '|' ||
        (select count(*)::text from public.vote_refund_events) || '|' ||
        (select count(*)::text from public.vote_refund_items)
      from public.submissions submission
      where submission.vote_refund_id is not null
        and submission.vote_refunded_at is not null
        and submission.is_disqualified
      order by submission.id
      limit 1;
    `
  );
  const [submissionId, eventCount, itemCount] = preflight.split("|");
  if (!/^\d+$/u.test(submissionId ?? "")) {
    throw new Error("DEV refunded-submission fixture unavailable.");
  }

  const results = await Promise.allSettled([
    runSql(
      databaseUrl,
      blockedReinstatementTransaction(submissionId, "0.75")
    ),
    runSql(databaseUrl, blockedReinstatementTransaction(submissionId, "0")),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;

  const postflight = await runSql(
    databaseUrl,
    `
      select
        (submission.vote_refund_id is not null and
         submission.vote_refunded_at is not null and
         submission.is_disqualified)::text || '|' ||
        (select count(*)::text from public.vote_refund_events) || '|' ||
        (select count(*)::text from public.vote_refund_items)
      from public.submissions submission
      where submission.id = ${submissionId};
    `
  );
  if (postflight !== `true|${eventCount}|${itemCount}`) {
    throw new Error("DEV refunded-submission concurrency state changed.");
  }

  console.log(
    "Manual Vote Refund DEV reinstatement concurrency guard passed; both transactions rolled back."
  );
}

await main();
