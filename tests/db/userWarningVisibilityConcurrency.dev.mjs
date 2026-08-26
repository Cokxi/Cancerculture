import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const psql = process.env.PSQL_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
let databaseUrl;
let actorId;
let targetId;
let publicCommentId;
let objectVersion;
let textVersion;
const requestId = randomUUID();

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
    throw new Error("Refusing to run Warning visibility concurrency outside DEV.");
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
      { cwd: repoRoot, windowsHide: true },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error(
      "The DEV Warning visibility concurrency command could not start.",
    )));
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error("A sanitized DEV Warning visibility concurrency command failed."));
    });
  });
}

async function scalar(sql) {
  return (await runSql(sql)).stdout;
}

function issueSql() {
  return `set role service_role; select public.issue_user_warning(
    ${literal(actorId)},
    ${literal(publicCommentId)}::uuid,
    ${objectVersion},
    ${textVersion},
    'other',
    'Parallel Warning notification replay contract.',
    ${literal(requestId)}::uuid
  )::text;`;
}

async function cleanup() {
  if (!targetId) return;
  await runSql(`begin;
    set local lock_timeout = '10s';
    alter table public.notification_events disable trigger notification_events_immutable;
    alter table public.user_warning_requests disable trigger protect_user_warning_requests;
    alter table public.user_warning_events disable trigger protect_user_warning_events;
    alter table public.user_warning_current disable trigger protect_user_warning_current_identity;
    alter table public.user_warnings disable trigger protect_user_warnings;
    delete from public.push_delivery_jobs where event_id in (
      select event_row.id from public.notification_events event_row
      where event_row.producer_key like 'user_warning_issued:%'
        and event_row.owner_discord_user_id = ${literal(targetId)}
    );
    delete from public.account_notifications where event_id in (
      select event_row.id from public.notification_events event_row
      where event_row.producer_key like 'user_warning_issued:%'
        and event_row.owner_discord_user_id = ${literal(targetId)}
    );
    delete from public.notification_events
      where producer_key like 'user_warning_issued:%'
        and owner_discord_user_id = ${literal(targetId)};
    delete from public.user_warning_requests where request_id = ${literal(requestId)}::uuid;
    delete from public.user_warning_events where warning_id in (
      select warning_id from public.user_warnings
      where source_public_comment_id = ${literal(publicCommentId)}::uuid
    );
    delete from public.user_warning_current where warning_id in (
      select warning_id from public.user_warnings
      where source_public_comment_id = ${literal(publicCommentId)}::uuid
    );
    delete from public.user_warnings
      where source_public_comment_id = ${literal(publicCommentId)}::uuid;
    alter table public.user_warnings enable trigger protect_user_warnings;
    alter table public.user_warning_current enable trigger protect_user_warning_current_identity;
    alter table public.user_warning_events enable trigger protect_user_warning_events;
    alter table public.user_warning_requests enable trigger protect_user_warning_requests;
    alter table public.notification_events enable trigger notification_events_immutable;
    commit;`);
}

databaseUrl = await loadDevDatabaseUrl();
actorId = await scalar(
  "select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;",
);
if (!actorId) throw new Error("DEV Admin actor is unavailable.");

const fixture = await scalar(`
  select comment_row.author_discord_user_id || '|' ||
    comment_row.public_comment_id::text || '|' ||
    comment_row.object_version::text || '|' ||
    comment_row.current_text_version::text
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.sessions session_row
    on session_row.discord_user_id = comment_row.author_discord_user_id
   and session_row.revoked_at is null
  where comment_row.author_deleted_at is null
    and text_version.normalized_body is not null
    and public.is_community_comment_submission_eligible(comment_row.submission_id)
    and not exists (
      select 1 from public.user_warnings warning_row
      where warning_row.target_discord_user_id = comment_row.author_discord_user_id
    )
  order by session_row.created_at desc, comment_row.created_at, comment_row.public_comment_id
  limit 1;
`);
[targetId, publicCommentId, objectVersion, textVersion] = fixture.split("|");
if (!targetId || !publicCommentId || !objectVersion || !textVersion) {
  throw new Error("DEV Warning visibility concurrency fixture is unavailable.");
}

const baseline = await scalar(`select
  (select count(*) from public.user_warnings)::text || '|' ||
  (select count(*) from public.notification_events where category_key='account_warnings')::text || '|' ||
  (select count(*) from public.team_role_capabilities where capability_key='users.warnings.view')::text;`);
if (baseline !== "1|0|0") {
  throw new Error("Refusing to run against unexpected DEV Warning visibility state.");
}

try {
  const results = await Promise.all([
    runSql(issueSql(), { allowFailure: true }),
    runSql(issueSql(), { allowFailure: true }),
  ]);
  if (results.some((result) => result.code !== 0)) {
    throw new Error("Parallel identical Warning requests did not both resolve safely.");
  }
  if (!results.some((result) => result.stdout.includes('"replayed": true'))) {
    throw new Error("Parallel identical Warning requests did not expose replay.");
  }

  const counts = await scalar(`select
    (select count(*) from public.user_warnings where source_public_comment_id=${literal(publicCommentId)}::uuid)::text || '|' ||
    (select count(*) from public.user_warning_requests where request_id=${literal(requestId)}::uuid)::text || '|' ||
    (select count(*) from public.notification_events event_row join public.user_warnings warning_row
      on event_row.producer_key='user_warning_issued:'||warning_row.warning_id::text
      where warning_row.source_public_comment_id=${literal(publicCommentId)}::uuid)::text || '|' ||
    (select count(*) from public.account_notifications notification join public.notification_events event_row
      on event_row.id=notification.event_id join public.user_warnings warning_row
      on event_row.producer_key='user_warning_issued:'||warning_row.warning_id::text
      where warning_row.source_public_comment_id=${literal(publicCommentId)}::uuid)::text || '|' ||
    (select count(*) from public.push_delivery_jobs delivery join public.notification_events event_row
      on event_row.id=delivery.event_id join public.user_warnings warning_row
      on event_row.producer_key='user_warning_issued:'||warning_row.warning_id::text
      where warning_row.source_public_comment_id=${literal(publicCommentId)}::uuid)::text;`);
  if (counts !== "1|1|1|1|0") {
    throw new Error("Parallel Warning replay duplicated canonical or Notification rows.");
  }
} finally {
  await cleanup();
}

const finalState = await scalar(`select
  (select count(*) from public.user_warnings)::text || '|' ||
  (select count(*) from public.notification_events where category_key='account_warnings')::text || '|' ||
  (select count(*) from public.account_notifications notification join public.notification_events event_row
    on event_row.id=notification.event_id where event_row.category_key='account_warnings')::text;`);
if (finalState !== "1|0|0") {
  throw new Error("DEV Warning visibility concurrency cleanup did not restore baseline.");
}

console.log("DEV Warning visibility concurrency passed with exact notification-once cleanup.");
