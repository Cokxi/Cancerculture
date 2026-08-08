import { randomUUID } from "node:crypto";
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
const runToken = randomUUID().replaceAll("-", "");
const runSeed = BigInt(`0x${runToken.slice(0, 12)}`);
const fixtureBase = 8_900_000_000n + (runSeed % 50_000_000n) * 20n;
const cycleId = fixtureBase + 1n;
const submissionAId = fixtureBase + 2n;
const submissionBId = fixtureBase + 3n;
const voteIds = [11n, 12n, 13n, 14n].map(
  (offset) => fixtureBase + offset
);
const requestA = randomUUID();
const requestB = randomUUID();

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

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
      [
        databaseUrl,
        "-X",
        "-q",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
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

async function cleanup(databaseUrl) {
  await runSql(
    databaseUrl,
    `
      do $guard$
      begin
        if exists (
          select 1 from public.vote_refund_events
          where idempotency_key in (${sqlText(requestA)}::uuid, ${sqlText(requestB)}::uuid)
        ) or exists (
          select 1 from public.vote_refund_items
          where refund_id in (${sqlText(requestA)}::uuid, ${sqlText(requestB)}::uuid)
        ) then
          raise exception 'MANUAL_VOTE_REFUND_CONCURRENCY_AUDIT_RESIDUE';
        end if;
      end;
      $guard$;
      delete from public.voting_cycles where id = ${cycleId};
    `
  );
}

function selections(reverse = false) {
  const rows = [
    [submissionAId, "2026-08-08T09:01:00Z"],
    [submissionBId, "2026-08-08T09:02:00Z"],
  ];
  if (reverse) rows.reverse();

  return `jsonb_build_array(${rows
    .map(
      ([submissionId, disqualifiedAt]) => `jsonb_build_object(
        'submissionId', ${submissionId},
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', ${sqlText(disqualifiedAt)}::timestamptz
      )`
    )
    .join(",")})`;
}

function refundTransaction(actorId, requestId, reverse) {
  return `
    begin;
    set local lock_timeout = '10s';
    set local statement_timeout = '30s';
    select public.refund_disqualified_votes(
      ${sqlText(actorId)},
      ${cycleId},
      4,
      4,
      ${selections(reverse)},
      'Rollback-only opposite-order concurrency test.',
      ${sqlText(requestId)}::uuid
    );
    select pg_sleep(1);
    rollback;
  `;
}

async function main() {
  const databaseUrl = await readDevDatabaseUrl();
  let prepared = false;

  try {
    const actorId = await runSql(
      databaseUrl,
      `
        select discord_user_id
        from public.team_members
        where role = 'admin'
        order by discord_user_id
        limit 1;
      `
    );
    if (!actorId) throw new Error("DEV Admin actor unavailable.");

    await runSql(
      databaseUrl,
      `
        do $preflight$
        begin
          if exists (
            select 1 from public.voting_cycles
            where status::text = 'voting_open' or id = ${cycleId}
          ) or exists (
            select 1 from public.vote_refund_events
            where idempotency_key in (${sqlText(requestA)}::uuid, ${sqlText(requestB)}::uuid)
          ) then
            raise exception 'MANUAL_VOTE_REFUND_CONCURRENCY_PREFLIGHT_DRIFT';
          end if;
        end;
        $preflight$;

        insert into public.voting_cycles (
          id, status, votes_per_user, reset_count, theme
        ) values (
          ${cycleId}, 'voting_open', 4, 4,
          'Temporary manual vote refund concurrency fixture'
        );
        insert into public.submissions (
          id, cycle_id, discord_user_id, is_disqualified,
          disqualification_type, disqualified_at
        ) values
          (${submissionAId}, ${cycleId}, 'refund-concurrency-submitter-a', true, 'manual', '2026-08-08T09:01:00Z'),
          (${submissionBId}, ${cycleId}, 'refund-concurrency-submitter-b', true, 'manual', '2026-08-08T09:02:00Z');
        insert into public.votes (
          id, cycle_id, submission_id, discord_user_id
        ) values
          (${voteIds[0]}, ${cycleId}, ${submissionAId}, 'refund-concurrency-voter-1'),
          (${voteIds[1]}, ${cycleId}, ${submissionAId}, 'refund-concurrency-voter-2'),
          (${voteIds[2]}, ${cycleId}, ${submissionBId}, 'refund-concurrency-voter-3'),
          (${voteIds[3]}, ${cycleId}, ${submissionBId}, 'refund-concurrency-voter-4');
      `
    );
    prepared = true;

    const results = await Promise.allSettled([
      runSql(databaseUrl, refundTransaction(actorId, requestA, false)),
      runSql(databaseUrl, refundTransaction(actorId, requestB, true)),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;

    await runSql(
      databaseUrl,
      `
        do $postflight$
        begin
          if (select count(*) from public.votes where cycle_id = ${cycleId}) <> 4
            or exists (
              select 1 from public.vote_refund_events
              where idempotency_key in (${sqlText(requestA)}::uuid, ${sqlText(requestB)}::uuid)
            )
            or exists (
              select 1 from public.vote_refund_items
              where refund_id in (${sqlText(requestA)}::uuid, ${sqlText(requestB)}::uuid)
            ) then
            raise exception 'MANUAL_VOTE_REFUND_CONCURRENCY_ROLLBACK_FAILED';
          end if;
        end;
        $postflight$;
      `
    );

    console.log(
      "Manual Vote Refund opposite-order DEV concurrency test passed without deadlock; both transactions rolled back."
    );
  } finally {
    if (prepared) await cleanup(databaseUrl);
  }
}

await main();
