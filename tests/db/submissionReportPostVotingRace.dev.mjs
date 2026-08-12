import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const psql =
  process.env.PSQL_BIN ??
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const runId = randomUUID();
const runSeed = BigInt(`0x${runId.replaceAll("-", "").slice(0, 12)}`);
const cycleId = Number(2_400_000_000n + (runSeed % 200_000_000n));
const submissionId = Number(2_700_000_000n + (runSeed % 200_000_000n));
const reporterId = `post-voting-race-${runId}`;
const requestId = randomUUID();
const signalKey = Number(runSeed % 1_500_000_000n);
let databaseUrl;
let baseline;

async function readEnv(name) {
  const values = new Map();
  const contents = await readFile(path.join(repoRoot, name), "utf8");
  for (const line of contents.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2"),
    );
  }
  return values;
}

function projectRef(value) {
  const parsed = new URL(value);
  return (
    parsed.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ??
    null
  );
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([
    readEnv(".env.local"),
    readEnv(".env.codex.local"),
  ]);
  const value =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    codex.get("SUPABASE_DEV_DATABASE_URL");
  const website =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    local.get("NEXT_PUBLIC_SUPABASE_URL");
  if (!value || !website) {
    throw new Error("Required DEV configuration is missing");
  }
  if (
    projectRef(value) !== "gceljiuydyiwkomymuqh" ||
    new URL(website).hostname.split(".")[0] !== "gceljiuydyiwkomymuqh"
  ) {
    throw new Error("Refusing to run against a non-DEV project");
  }
  return value;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { windowsHide: true },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      reject(new Error("The DEV database command could not start"));
    });
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error("A sanitized DEV database command failed"));
    });
  });
}

async function scalar(sql) {
  return (await runSql(sql)).stdout;
}

async function waitForPhaseLock() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const acquired = await scalar(`
      select pg_try_advisory_lock(${signalKey})::text;
      select case
        when pg_advisory_unlock(${signalKey}) then 'released'
        else 'contended'
      end;
    `);
    if (acquired.startsWith("false")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The phase transaction did not acquire its race signal");
}

async function cleanupFixture() {
  await runSql(`
    delete from public.submissions where id = ${submissionId};
    delete from public.voting_cycles where id = ${cycleId};
    delete from public.user_logs where discord_user_id = ${literal(reporterId)};
  `);
}

databaseUrl = await loadDevDatabaseUrl();
const unfinished = await scalar(`
  select count(*)
  from public.voting_cycles
  where status::text in (
    'active', 'submission_open', 'submission_closed', 'voting_open',
    'voting_closed', 'paused', 'finalizing'
  );
`);
if (unfinished !== "0") {
  throw new Error("DEV must have no current Cycle before the isolated race");
}
if (
  (await scalar(`select (to_regprocedure('public.enforce_submission_report_creation_phase()') is not null)::text;`)) !==
  "true"
) {
  throw new Error("The post-Voting Report lock migration is not applied");
}
const collision = await scalar(`
  select
    (exists (select 1 from public.voting_cycles where id = ${cycleId})
      or exists (select 1 from public.submissions where id = ${submissionId})
      or exists (
        select 1 from public.user_logs
        where discord_user_id = ${literal(reporterId)}
      ))::text;
`);
if (collision !== "false") {
  throw new Error("The isolated race fixture identifiers already exist");
}

baseline = await scalar(`
  select jsonb_build_object(
    'publicCount', count(public_number),
    'publicMax', coalesce(max(public_number), 0),
    'identities', (select count(*) from public.submission_reporter_identities),
    'cases', (select count(*) from public.submission_report_cases),
    'reports', (select count(*) from public.submission_reports),
    'payloads', (select count(*) from public.submission_report_payloads),
    'events', (select count(*) from public.submission_report_case_events),
    'requests', (select count(*) from public.submission_report_requests),
    'reads', (select count(*) from public.submission_report_reads)
  )::text
  from public.voting_cycles;
`);

try {
  await runSql(`
    insert into public.user_logs (discord_user_id, current_discord_username)
    values (${literal(reporterId)}, 'post-voting-race-reporter');
    insert into public.voting_cycles (
      id, status, theme, title, voting_starts_at, voting_ends_at
    ) values (
      ${cycleId}, 'voting_open', 'Post-Voting Race', 'Post-Voting Race',
      transaction_timestamp() - interval '1 hour',
      transaction_timestamp() + interval '1 hour'
    );
    insert into public.submissions (
      id, cycle_id, discord_user_id, public_visibility_status
    ) values (
      ${submissionId}, ${cycleId}, 'post-voting-race-subject', 'visible'
    );
  `);

  const phaseCommit = runSql(`
    begin;
    update public.voting_cycles
    set status = 'voting_closed', voting_ends_at = transaction_timestamp()
    where id = ${cycleId};
    select pg_advisory_lock(${signalKey});
    select pg_sleep(1);
    commit;
    select pg_advisory_unlock(${signalKey});
  `);
  await waitForPhaseLock();
  const reportAttempt = runSql(
    `select public.create_submission_report_v2(
      ${literal(reporterId)}, 1, repeat('a', 64), ${submissionId}, 2,
      'privacy_or_personal_information', 'doxxing',
      'The phase transition must win this race.',
      ${literal(requestId)}::uuid
    )::text;`,
    { allowFailure: true },
  );
  const [phaseResult, reportResult] = await Promise.all([
    phaseCommit,
    reportAttempt,
  ]);
  if (phaseResult.code !== 0 || reportResult.code === 0) {
    throw new Error("The phase-first race did not reject Report creation");
  }

  const residue = await scalar(`
    select
      (select status::text from public.voting_cycles where id = ${cycleId}) || ':' ||
      (select count(*) from public.submission_reporter_identities where discord_user_id = ${literal(reporterId)}) || ':' ||
      (select count(*) from public.submission_report_cases where cycle_id = ${cycleId}) || ':' ||
      (select count(*) from public.submission_reports where cycle_id = ${cycleId}) || ':' ||
      (select count(*) from public.submission_report_requests where idempotency_key = ${literal(requestId)}::uuid) || ':' ||
      (select count(*) from public.submission_report_reads read_row
        join public.submission_reports report on report.report_id = read_row.report_id
        where report.cycle_id = ${cycleId});
  `);
  if (residue !== "voting_closed:0:0:0:0:0") {
    throw new Error("The rejected race left Submission Report residue");
  }
} finally {
  await cleanupFixture();
}

const postflight = await scalar(`
  select jsonb_build_object(
    'publicCount', count(public_number),
    'publicMax', coalesce(max(public_number), 0),
    'identities', (select count(*) from public.submission_reporter_identities),
    'cases', (select count(*) from public.submission_report_cases),
    'reports', (select count(*) from public.submission_reports),
    'payloads', (select count(*) from public.submission_report_payloads),
    'events', (select count(*) from public.submission_report_case_events),
    'requests', (select count(*) from public.submission_report_requests),
    'reads', (select count(*) from public.submission_report_reads)
  )::text
  from public.voting_cycles;
`);
if (postflight !== baseline) {
  throw new Error("The isolated race did not restore its exact DEV baseline");
}

console.log("Post-Voting Submission Report phase-first race passed without residue.");
