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
const psql = process.env.PSQL_BIN
  ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
let databaseUrl;

function projectRef(value) {
  const parsed = new URL(value);
  return parsed.hostname.match(/^db\.([^.]+)\./u)?.[1]
    ?? decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1]
    ?? null;
}

async function loadDevDatabaseUrl() {
  const source = await readFile(path.join(repoRoot, ".env.codex.local"), "utf8");
  const line = source.split(/\r?\n/u).find((candidate) =>
    /^\s*SUPABASE_DEV_DATABASE_URL\s*=/u.test(candidate)
  );
  const value = process.env.SUPABASE_DEV_DATABASE_URL
    ?? line?.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
  if (!value || projectRef(value) !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run Overwatch concurrency outside DEV.");
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
      [databaseUrl, "-X", "--no-password", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.on("error", () =>
      reject(new Error("The DEV Overwatch concurrency command could not start."))
    );
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error("A sanitized DEV Overwatch concurrency command failed."));
    });
  });
}

async function scalar(sql) {
  return (await runSql(sql)).stdout;
}

function addSql(actor, target, expectedState, expectedVersion, reason, requestId) {
  return `set role service_role; select public.add_user_to_overwatch(
    ${literal(actor)}, ${literal(target)}, ${literal(expectedState)},
    ${expectedVersion}, ${literal(reason)}, ${literal(requestId)}::uuid
  )::text;`;
}

function removeSql(actor, target, entryId, reason, requestId) {
  return `set role service_role; select public.remove_user_from_overwatch(
    ${literal(actor)}, ${literal(target)}, ${literal(entryId)}::uuid,
    'active', 1, ${literal(reason)}, ${literal(requestId)}::uuid
  )::text;`;
}

databaseUrl = await loadDevDatabaseUrl();
const actor = await scalar(
  "select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;",
);
const targets = (await scalar(`
  select string_agg(user_row.discord_user_id, ',' order by user_row.discord_user_id)
  from (
    select candidate.discord_user_id
    from public.user_logs candidate
    where candidate.discord_user_id <> ${literal(actor)}
      and not exists (
        select 1 from public.team_members member
        where member.discord_user_id = candidate.discord_user_id
      )
      and not exists (
        select 1 from public.user_overwatch_generations generation_row
        where generation_row.target_discord_user_id = candidate.discord_user_id
      )
    order by candidate.discord_user_id
    limit 2
  ) user_row;
`)).split(",").filter(Boolean);
if (!actor || targets.length !== 2) {
  throw new Error("DEV Overwatch concurrency fixtures are unavailable.");
}
if ((await scalar("select count(*)::text from public.user_overwatch_generations;")) !== "0") {
  throw new Error("Refusing to rerun the permanent DEV Overwatch concurrency evidence.");
}

const productBaseline = await scalar(`select
  (select count(*) from public.user_flag_cases)::text || ':' ||
  (select count(*) from public.user_warning_auto_flag_cases)::text || ':' ||
  (select count(*) from public.user_warnings)::text || ':' ||
  (select count(*) from public.account_notifications)::text || ':' ||
  (select count(*) from public.push_delivery_jobs)::text || ':' ||
  (select count(*) from public.submission_report_cases)::text || ':' ||
  (select count(*) from public.community_comments)::text;`);

const distinctAdds = await Promise.all([
  runSql(addSql(actor, targets[0], "absent", 0, "Concurrent distinct Add A.", randomUUID()), { allowFailure: true }),
  runSql(addSql(actor, targets[0], "absent", 0, "Concurrent distinct Add B.", randomUUID()), { allowFailure: true }),
]);
if (distinctAdds.filter((result) => result.code === 0).length !== 1) {
  throw new Error("Distinct concurrent Adds did not serialize to one winner.");
}
const firstEntry = await scalar(`
  select generation_row.public_entry_id::text
  from public.user_overwatch_generations generation_row
  join public.user_overwatch_current current_row on current_row.entry_id=generation_row.entry_id
  where generation_row.target_discord_user_id=${literal(targets[0])}
    and current_row.state='active';
`);
const distinctRemoves = await Promise.all([
  runSql(removeSql(actor, targets[0], firstEntry, "Concurrent distinct Remove A.", randomUUID()), { allowFailure: true }),
  runSql(removeSql(actor, targets[0], firstEntry, "Concurrent distinct Remove B.", randomUUID()), { allowFailure: true }),
]);
if (distinctRemoves.filter((result) => result.code === 0).length !== 1) {
  throw new Error("Distinct concurrent Removes did not serialize to one winner.");
}

const identicalAddRequest = randomUUID();
const identicalAdds = await Promise.all([
  runSql(addSql(actor, targets[1], "absent", 0, "Concurrent identical Add.", identicalAddRequest)),
  runSql(addSql(actor, targets[1], "absent", 0, "Concurrent identical Add.", identicalAddRequest)),
]);
if (!identicalAdds.some((result) => result.stdout.includes('"replayed": true'))) {
  throw new Error("Identical concurrent Add did not return a replay receipt.");
}
const secondEntry = await scalar(`
  select generation_row.public_entry_id::text
  from public.user_overwatch_generations generation_row
  join public.user_overwatch_current current_row on current_row.entry_id=generation_row.entry_id
  where generation_row.target_discord_user_id=${literal(targets[1])}
    and current_row.state='active';
`);
const identicalRemoveRequest = randomUUID();
const identicalRemoves = await Promise.all([
  runSql(removeSql(actor, targets[1], secondEntry, "Concurrent identical Remove.", identicalRemoveRequest)),
  runSql(removeSql(actor, targets[1], secondEntry, "Concurrent identical Remove.", identicalRemoveRequest)),
]);
if (!identicalRemoves.some((result) => result.stdout.includes('"replayed": true'))) {
  throw new Error("Identical concurrent Remove did not return a replay receipt.");
}

const finalState = await scalar(`select
  (select count(*) from public.user_overwatch_generations)::text || ':' ||
  (select count(*) from public.user_overwatch_current where state='active')::text || ':' ||
  (select count(*) from public.user_overwatch_current where state='removed')::text || ':' ||
  (select count(*) from public.user_overwatch_events)::text || ':' ||
  (select count(*) from public.user_overwatch_requests)::text;`);
if (finalState !== "2:0:2:4:4") {
  throw new Error("DEV Overwatch concurrency final state is not exact.");
}
const productFinal = await scalar(`select
  (select count(*) from public.user_flag_cases)::text || ':' ||
  (select count(*) from public.user_warning_auto_flag_cases)::text || ':' ||
  (select count(*) from public.user_warnings)::text || ':' ||
  (select count(*) from public.account_notifications)::text || ':' ||
  (select count(*) from public.push_delivery_jobs)::text || ':' ||
  (select count(*) from public.submission_report_cases)::text || ':' ||
  (select count(*) from public.community_comments)::text;`);
if (productFinal !== productBaseline) {
  throw new Error("DEV Overwatch concurrency changed an excluded product domain.");
}

console.log("DEV Overwatch concurrency passed: 2:0:2:4:4, no product side effects.");
