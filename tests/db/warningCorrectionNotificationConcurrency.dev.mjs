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
let actorId;
let publicCommentId;
let warningId;
let publicWarningId;
const issueRequestId = randomUUID();
const overruleRequestId = randomUUID();
const competingRequestId = randomUUID();

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
    throw new Error("Refusing Warning correction concurrency outside DEV.");
  }
  return value;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql, { allowFailure = false, label = "query" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => reject(new Error(
      "The DEV Warning correction concurrency command could not start.",
    )));
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(
        `A sanitized DEV Warning correction ${label} failed. ${stderr
          .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
          .trim()
          .slice(0, 1000)}`,
      ));
    });
  });
}

async function scalar(sql) {
  return (await runSql(sql)).stdout;
}

function overruleSql(requestId) {
  return `set role service_role; select public.overrule_user_warning(
    ${literal(actorId)},
    ${literal(publicWarningId)}::uuid,
    1,
    'Parallel rollback-only Warning correction.',
    ${literal(requestId)}::uuid
  )::text;`;
}

async function cleanup() {
  if (!warningId) return;
  await runSql(`begin;
    set local lock_timeout = '10s';
    alter table public.notification_events disable trigger notification_events_immutable;
    alter table public.user_warning_requests disable trigger protect_user_warning_requests;
    alter table public.user_warning_events disable trigger protect_user_warning_events;
    alter table public.user_warning_current disable trigger protect_user_warning_current_identity;
    alter table public.user_warnings disable trigger protect_user_warnings;
    delete from public.push_delivery_jobs where event_id in (
      select id from public.notification_events
      where producer_key in (
        'user_warning_issued:' || ${literal(warningId)},
        'user_warning_overruled:' || ${literal(warningId)}
      )
    );
    delete from public.account_notifications where event_id in (
      select id from public.notification_events
      where producer_key in (
        'user_warning_issued:' || ${literal(warningId)},
        'user_warning_overruled:' || ${literal(warningId)}
      )
    );
    delete from public.notification_events where producer_key in (
      'user_warning_issued:' || ${literal(warningId)},
      'user_warning_overruled:' || ${literal(warningId)}
    );
    delete from public.user_warning_requests where request_id in (
      ${literal(issueRequestId)}::uuid,
      ${literal(overruleRequestId)}::uuid,
      ${literal(competingRequestId)}::uuid
    );
    delete from public.user_warning_events where warning_id=${literal(warningId)}::uuid;
    delete from public.user_warning_current where warning_id=${literal(warningId)}::uuid;
    delete from public.user_warnings where warning_id=${literal(warningId)}::uuid;
    alter table public.user_warnings enable trigger protect_user_warnings;
    alter table public.user_warning_current enable trigger protect_user_warning_current_identity;
    alter table public.user_warning_events enable trigger protect_user_warning_events;
    alter table public.user_warning_requests enable trigger protect_user_warning_requests;
    alter table public.notification_events enable trigger notification_events_immutable;
    commit;`, { label: "cleanup" });
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
    on text_version.comment_id=comment_row.id
   and text_version.version=comment_row.current_text_version
  where comment_row.author_deleted_at is null
    and text_version.normalized_body is not null
    and public.is_community_comment_submission_eligible(comment_row.submission_id)
    and exists (
      select 1 from public.sessions session_row
      where session_row.discord_user_id=comment_row.author_discord_user_id
        and session_row.revoked_at is null
    )
    and not exists (
      select 1 from public.user_warnings warning_row
      where warning_row.target_discord_user_id=comment_row.author_discord_user_id
    )
  order by comment_row.created_at, comment_row.public_comment_id
  limit 1;
`);
const [fixtureTarget, fixtureComment, objectVersion, textVersion] = fixture.split("|");
if (!fixtureTarget || !fixtureComment || !objectVersion || !textVersion) {
  throw new Error("DEV Warning correction concurrency fixture is unavailable.");
}
publicCommentId = fixtureComment;

const baseline = await scalar(`select
  (select count(*) from public.user_warnings)::text || '|' ||
  (select count(*) from public.user_warning_events)::text || '|' ||
  (select count(*) from public.notification_events where event_type='user_warning_overruled')::text || '|' ||
  (select count(*) from public.push_delivery_jobs delivery join public.notification_events event_row on event_row.id=delivery.event_id where event_row.event_type='user_warning_overruled')::text;`);

try {
  const issueReceipt = await scalar(`set role service_role; select public.issue_user_warning(
    ${literal(actorId)},
    ${literal(publicCommentId)}::uuid,
    ${objectVersion},
    ${textVersion},
    'other',
    'Rollback-only Warning correction concurrency fixture.',
    ${literal(issueRequestId)}::uuid
  )::text;`);
  if (!issueReceipt.includes('"tierDays": 1')) {
    throw new Error("DEV Warning correction fixture did not start at tier one.");
  }
  warningId = await scalar(`select warning_id::text from public.user_warnings
    where source_public_comment_id=${literal(publicCommentId)}::uuid;`);
  if (!warningId) throw new Error("DEV Warning correction fixture identity is unavailable.");
  publicWarningId = await scalar(`select public_warning_id::text from public.user_warnings
    where warning_id=${literal(warningId)}::uuid;`);
  if (!publicWarningId) {
    throw new Error("DEV Warning correction public identity is unavailable.");
  }

  const identical = await Promise.all([
    runSql(overruleSql(overruleRequestId), { label: "identical Overrule A" }),
    runSql(overruleSql(overruleRequestId), { label: "identical Overrule B" }),
  ]);
  if (!identical.some((result) => result.stdout.includes('"replayed": true'))) {
    throw new Error("Parallel identical Overrule did not return canonical replay.");
  }

  const competing = await runSql(overruleSql(competingRequestId), {
    allowFailure: true,
  });
  if (competing.code === 0) {
    throw new Error("A distinct repeated Overrule did not fail closed.");
  }

  const counts = await scalar(`select
    (select count(*) from public.user_warning_events where warning_id=${literal(warningId)}::uuid and event_type='overruled')::text || '|' ||
    (select count(*) from public.user_warning_requests where request_id=${literal(overruleRequestId)}::uuid)::text || '|' ||
    (select count(*) from public.notification_events where producer_key='user_warning_overruled:'||${literal(warningId)})::text || '|' ||
    (select count(*) from public.account_notifications notification join public.notification_events event_row on event_row.id=notification.event_id where event_row.producer_key='user_warning_overruled:'||${literal(warningId)})::text || '|' ||
    (select count(*) from public.push_delivery_jobs delivery join public.notification_events event_row on event_row.id=delivery.event_id where event_row.producer_key='user_warning_overruled:'||${literal(warningId)})::text;`);
  if (counts !== "1|1|1|1|0") {
    throw new Error("Concurrent Warning correction did not preserve notification-once semantics.");
  }
} finally {
  await cleanup();
}

const after = await scalar(`select
  (select count(*) from public.user_warnings)::text || '|' ||
  (select count(*) from public.user_warning_events)::text || '|' ||
  (select count(*) from public.notification_events where event_type='user_warning_overruled')::text || '|' ||
  (select count(*) from public.push_delivery_jobs delivery join public.notification_events event_row on event_row.id=delivery.event_id where event_row.event_type='user_warning_overruled')::text;`);
if (after !== baseline) {
  throw new Error("DEV Warning correction concurrency cleanup did not restore baseline.");
}

console.log(
  "DEV Warning correction concurrency passed: one audit event, one in-app notification, zero Push, exact cleanup.",
);
