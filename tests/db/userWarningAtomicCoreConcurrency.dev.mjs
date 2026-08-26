import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const psql =
  process.env.PSQL_BIN ??
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
let databaseUrl;
let adminId;
let targetId;

function projectRef(value) {
  const parsed = new URL(value);
  return parsed.hostname.match(/^db\.([^.]+)\./u)?.[1]
    ?? decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1]
    ?? null;
}

async function loadDevDatabaseUrl() {
  const source = await readFile(
    path.join(repoRoot, ".env.codex.local"),
    "utf8"
  );
  const line = source
    .split(/\r?\n/u)
    .find((candidate) =>
      /^\s*SUPABASE_DEV_DATABASE_URL\s*=/u.test(candidate)
    );
  const value = process.env.SUPABASE_DEV_DATABASE_URL
    ?? line?.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
  if (!value || projectRef(value) !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run Warning concurrency outside DEV.");
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
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.on("error", () =>
      reject(new Error("The DEV Warning concurrency command could not start."))
    );
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error("A sanitized DEV Warning concurrency command failed."));
    });
  });
}

async function scalar(sql) {
  return (await runSql(sql)).stdout;
}

function issueSql(source, requestId, reason) {
  return `set role service_role; select public.issue_user_warning(
    ${literal(adminId)},
    ${literal(source.publicId)}::uuid,
    ${source.objectVersion},
    ${source.textVersion},
    'other',
    ${literal(reason)},
    ${literal(requestId)}::uuid
  )::text;`;
}

function overruleSql(publicWarningId, requestId) {
  return `set role service_role; select public.overrule_user_warning(
    ${literal(adminId)},
    ${literal(publicWarningId)}::uuid,
    1,
    'Parallel rollback-only Warning correction.',
    ${literal(requestId)}::uuid
  )::text;`;
}

async function cleanup() {
  await runSql(`begin;
    set local lock_timeout = '10s';
    alter table public.user_warning_auto_flag_events disable trigger protect_user_warning_auto_flag_events;
    alter table public.user_warning_auto_flag_cases disable trigger protect_user_warning_auto_flag_case_identity;
    alter table public.user_warning_requests disable trigger protect_user_warning_requests;
    alter table public.user_warning_events disable trigger protect_user_warning_events;
    alter table public.user_warning_current disable trigger protect_user_warning_current_identity;
    alter table public.user_warnings disable trigger protect_user_warnings;
    delete from public.user_warning_auto_flag_events where case_id in (
      select case_id from public.user_warning_auto_flag_cases
      where target_discord_user_id = ${literal(targetId)}
    );
    delete from public.user_warning_auto_flag_cases
      where target_discord_user_id = ${literal(targetId)};
    delete from public.user_warning_requests
      where target_discord_user_id = ${literal(targetId)};
    delete from public.user_warning_events
      where target_discord_user_id = ${literal(targetId)};
    delete from public.user_warning_current
      where target_discord_user_id = ${literal(targetId)};
    delete from public.user_warnings
      where target_discord_user_id = ${literal(targetId)};
    alter table public.user_warnings enable trigger protect_user_warnings;
    alter table public.user_warning_current enable trigger protect_user_warning_current_identity;
    alter table public.user_warning_events enable trigger protect_user_warning_events;
    alter table public.user_warning_requests enable trigger protect_user_warning_requests;
    alter table public.user_warning_auto_flag_cases enable trigger protect_user_warning_auto_flag_case_identity;
    alter table public.user_warning_auto_flag_events enable trigger protect_user_warning_auto_flag_events;
    commit;`);
}

databaseUrl = await loadDevDatabaseUrl();
adminId = await scalar(
  "select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;"
);
if (!adminId) throw new Error("DEV Admin actor is unavailable.");

const fixture = await scalar(`
  with target as (
    select comment_row.author_discord_user_id
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id=comment_row.id
     and text_version.version=comment_row.current_text_version
    where comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and public.is_community_comment_submission_eligible(comment_row.submission_id)
    group by comment_row.author_discord_user_id
    having count(*) >= 2
    order by count(*) desc, comment_row.author_discord_user_id
    limit 1
  )
  select target.author_discord_user_id || '|' || string_agg(
    comment_row.public_comment_id::text || ',' ||
    comment_row.object_version::text || ',' ||
    comment_row.current_text_version::text,
    ';' order by comment_row.created_at, comment_row.public_comment_id
  )
  from target
  join lateral (
    select candidate.*
    from public.community_comments candidate
    join public.community_comment_text_versions text_version
      on text_version.comment_id=candidate.id
     and text_version.version=candidate.current_text_version
    where candidate.author_discord_user_id=target.author_discord_user_id
      and candidate.author_deleted_at is null
      and text_version.normalized_body is not null
      and public.is_community_comment_submission_eligible(candidate.submission_id)
    order by candidate.created_at, candidate.public_comment_id
    limit 2
  ) comment_row on true
  group by target.author_discord_user_id;
`);

const [fixtureTarget, encodedSources] = fixture.split("|");
const sources = encodedSources?.split(";").map((value) => {
  const [publicId, objectVersion, textVersion] = value.split(",");
  return { publicId, objectVersion, textVersion };
});
if (!fixtureTarget || sources?.length !== 2) {
  throw new Error("DEV Warning concurrency fixtures are unavailable.");
}
targetId = fixtureTarget;

const baseline = await scalar(`select
  (select count(*) from public.user_warnings)::text || ':' ||
  (select count(*) from public.user_warning_events)::text || ':' ||
  (select count(*) from public.user_warning_requests)::text || ':' ||
  (select count(*) from public.user_warning_auto_flag_cases)::text;`);
if (baseline !== "0:0:0:0") {
  throw new Error("Refusing to clean non-fixture DEV Warning state.");
}

try {
  const distinct = await Promise.all([
    runSql(
      issueSql(sources[0], randomUUID(), "Parallel distinct Warning issue A."),
      { allowFailure: true }
    ),
    runSql(
      issueSql(sources[0], randomUUID(), "Parallel distinct Warning issue B."),
      { allowFailure: true }
    ),
  ]);
  if (distinct.filter((result) => result.code === 0).length !== 1) {
    throw new Error("Parallel distinct source issues did not serialize to one Warning.");
  }
  if ((await scalar(`select count(*)::text from public.user_warnings where source_public_comment_id=${literal(sources[0].publicId)}::uuid;`)) !== "1") {
    throw new Error("Parallel source issues violated permanent Comment uniqueness.");
  }

  const replayRequest = randomUUID();
  const identical = await Promise.all([
    runSql(issueSql(sources[1], replayRequest, "Parallel identical Warning issue.")),
    runSql(issueSql(sources[1], replayRequest, "Parallel identical Warning issue.")),
  ]);
  if (!identical.some((result) => result.stdout.includes('"replayed": true'))) {
    throw new Error("Parallel identical Warning issue did not replay.");
  }
  if ((await scalar(`select count(*)::text from public.user_warning_requests where request_id=${literal(replayRequest)}::uuid;`)) !== "1") {
    throw new Error("Parallel identical Warning issue duplicated its request ledger.");
  }

  const publicWarningId = await scalar(`select public_warning_id::text from public.user_warnings where source_public_comment_id=${literal(sources[0].publicId)}::uuid;`);
  const overrules = await Promise.all([
    runSql(overruleSql(publicWarningId, randomUUID()), { allowFailure: true }),
    runSql(overruleSql(publicWarningId, randomUUID()), { allowFailure: true }),
  ]);
  if (overrules.filter((result) => result.code === 0).length !== 1) {
    throw new Error("Parallel Warning Overrules did not enforce expected-version single-winner semantics.");
  }
  if ((await scalar(`select count(*)::text from public.user_warning_events event_row join public.user_warnings warning_row on warning_row.warning_id=event_row.warning_id where warning_row.public_warning_id=${literal(publicWarningId)}::uuid and event_row.event_type='overruled';`)) !== "1") {
    throw new Error("Parallel Warning Overrules duplicated correction history.");
  }

  console.log("DEV Warning concurrency, source uniqueness, replay, and Overrule tests passed.");
} finally {
  await cleanup();
}

const after = await scalar(`select
  (select count(*) from public.user_warnings)::text || ':' ||
  (select count(*) from public.user_warning_events)::text || ':' ||
  (select count(*) from public.user_warning_requests)::text || ':' ||
  (select count(*) from public.user_warning_auto_flag_cases)::text;`);
if (after !== baseline) {
  throw new Error("DEV Warning concurrency cleanup did not restore aggregate state.");
}
console.log("DEV Warning concurrency cleanup passed.");
