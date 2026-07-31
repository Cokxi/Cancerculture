import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const psql = process.env.PSQL_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const runId = randomUUID().replaceAll("-", "");
const prefix = `user-flag-race-${runId}`;
const targets = [`${prefix}-one`, `${prefix}-two`, `${prefix}-three`];
let databaseUrl;
let adminId;

async function readEnv(name) {
  const values = new Map();
  const contents = await readFile(path.join(repoRoot, name), "utf8");
  for (const line of contents.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2"));
  }
  return values;
}

function projectRef(value) {
  const parsed = new URL(value);
  return parsed.hostname.match(/^db\.([^.]+)\./u)?.[1]
    ?? decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1]
    ?? null;
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([readEnv(".env.local"), readEnv(".env.codex.local")]);
  const value = process.env.SUPABASE_DEV_DATABASE_URL ?? codex.get("SUPABASE_DEV_DATABASE_URL");
  const website = process.env.NEXT_PUBLIC_SUPABASE_URL ?? local.get("NEXT_PUBLIC_SUPABASE_URL");
  if (!value || !website) throw new Error("Required DEV configuration is missing");
  if (projectRef(value) !== new URL(website).hostname.split(".")[0]) {
    throw new Error("Refusing to run against a non-matching database project");
  }
  if (projectRef(value) !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run outside the approved DEV project");
  }
  return value;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("The DEV database command could not start")));
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

function createSql(target, requestId, reason = "Parallel user flag create.") {
  return `set role service_role; select public.create_user_flag_case(${literal(adminId)},${literal(target)},'other',${literal(reason)},null,null,${literal(requestId)}::uuid)::text;`;
}

function reviewSql(caseId, requestId, status) {
  return `set role service_role; select public.review_user_flag_case(${literal(adminId)},${literal(caseId)}::uuid,1,${literal(status)},'Parallel user flag review.',${literal(requestId)}::uuid)::text;`;
}

async function cleanup() {
  await runSql(`begin;
    alter table public.user_flag_requests disable trigger protect_user_flag_requests;
    alter table public.user_flag_events disable trigger protect_user_flag_events;
    alter table public.user_flag_cases disable trigger protect_user_flag_cases_delete;
    delete from public.user_flag_requests where result ->> 'caseId' in (
      select case_id::text from public.user_flag_cases where discord_user_id like ${literal(`${prefix}%`)}
    );
    delete from public.user_flag_events where case_id in (
      select case_id from public.user_flag_cases where discord_user_id like ${literal(`${prefix}%`)}
    );
    delete from public.user_flag_cases where discord_user_id like ${literal(`${prefix}%`)};
    alter table public.user_flag_cases enable trigger protect_user_flag_cases_delete;
    alter table public.user_flag_events enable trigger protect_user_flag_events;
    alter table public.user_flag_requests enable trigger protect_user_flag_requests;
    delete from public.user_logs where discord_user_id like ${literal(`${prefix}%`)};
    commit;`);
}

databaseUrl = await loadDevDatabaseUrl();
adminId = await scalar("select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;");
if (!adminId) throw new Error("DEV admin actor is unavailable");
const baseline = await scalar("select (select count(*) from public.user_flag_cases)::text||':'||(select count(*) from public.user_flag_events)::text||':'||(select count(*) from public.user_flag_requests)::text;");

try {
  await cleanup();
  await runSql(`insert into public.user_logs (discord_user_id,current_discord_username) values ${targets.map((target) => `(${literal(target)},${literal(target)})`).join(",")};`);

  const distinct = await Promise.all([
    runSql(createSql(targets[0], randomUUID()), { allowFailure: true }),
    runSql(createSql(targets[0], randomUUID()), { allowFailure: true }),
  ]);
  if (distinct.filter((result) => result.code === 0).length !== 1) {
    throw new Error("Parallel distinct creates did not serialize to one open case");
  }
  if ((await scalar(`select count(*)::text from public.user_flag_cases where discord_user_id=${literal(targets[0])}`)) !== "1") {
    throw new Error("Parallel distinct creates violated the one-open-case invariant");
  }

  const retryKey = randomUUID();
  const identical = await Promise.all([
    runSql(createSql(targets[1], retryKey)),
    runSql(createSql(targets[1], retryKey)),
  ]);
  if (!identical.some((result) => result.stdout.includes('"replayed": true'))) {
    throw new Error("Parallel identical create did not replay the stored result");
  }
  if ((await scalar(`select count(*)::text from public.user_flag_requests where result ->> 'caseId'=(select case_id::text from public.user_flag_cases where discord_user_id=${literal(targets[1])})`)) !== "1") {
    throw new Error("Parallel identical create duplicated its ledger row");
  }

  await runSql(createSql(targets[2], randomUUID(), "Create before parallel review."));
  const caseId = await scalar(`select case_id::text from public.user_flag_cases where discord_user_id=${literal(targets[2])}`);
  const reviews = await Promise.all([
    runSql(reviewSql(caseId, randomUUID(), "resolved"), { allowFailure: true }),
    runSql(reviewSql(caseId, randomUUID(), "dismissed"), { allowFailure: true }),
  ]);
  if (reviews.filter((result) => result.code === 0).length !== 1) {
    throw new Error("Parallel reviews did not serialize to one decision");
  }
  if ((await scalar(`select count(*)::text from public.user_flag_events where case_id=${literal(caseId)}::uuid`)) !== "2") {
    throw new Error("Parallel reviews duplicated or lost history");
  }
  console.log("DEV user flag concurrency tests passed.");
} finally {
  await cleanup();
}

const after = await scalar("select (select count(*) from public.user_flag_cases)::text||':'||(select count(*) from public.user_flag_events)::text||':'||(select count(*) from public.user_flag_requests)::text;");
if (after !== baseline) throw new Error("DEV user flag concurrency cleanup did not restore aggregate state");
console.log("DEV user flag concurrency cleanup passed.");
