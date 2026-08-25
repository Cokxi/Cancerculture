import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const psql = process.env.PSQL_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
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
    throw new Error("Refusing to run Comment notification concurrency outside DEV.");
  }
  return value;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runSql(databaseUrl, sql) {
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
    child.on("error", () => reject(new Error("The DEV notification concurrency command could not start.")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr.replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ").trim().slice(0, 500);
      reject(new Error(`Sanitized DEV notification concurrency SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

async function runJson(databaseUrl, sql) {
  return JSON.parse(await runSql(databaseUrl, sql));
}

async function ownerSession(databaseUrl) {
  return runSql(databaseUrl, `
    select session_row.id
    from public.sessions session_row
    join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
    join public.team_members member on member.discord_user_id = session_row.discord_user_id
    where session_row.revoked_at is null and member.role = 'admin' and not user_log.is_banned
    order by session_row.created_at desc limit 1;
  `);
}

async function actors(databaseUrl) {
  return runJson(databaseUrl, `
    select coalesce(json_agg(json_build_object(
      'sessionId', selected.id,
      'actor', selected.discord_user_id,
      'profileId', selected.public_profile_id
    ) order by selected.discord_user_id), '[]'::json)
    from (
      select distinct on (session_row.discord_user_id)
        session_row.id, session_row.discord_user_id, user_log.public_profile_id
      from public.sessions session_row
      join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
      left join public.discord_member_state member_state
        on member_state.discord_user_id = session_row.discord_user_id
      where session_row.revoked_at is null
        and user_log.public_profile_id is not null
        and not user_log.is_banned
        and not coalesce(member_state.discord_ban_active, false)
      order by session_row.discord_user_id, session_row.created_at desc
      limit 3
    ) selected;
  `);
}

async function setPolicy(databaseUrl, adminSession, action, activate) {
  const result = activate
    ? await runJson(databaseUrl, `
        select public.manage_community_comment_abuse_policy(
          ${quote(adminSession)}::uuid, ${quote(action)}, state.state_version, true,
          source.window_seconds, source.max_actions, source.cooldown_seconds,
          source.turnstile_after, ${quote(randomUUID())}::uuid
        )
        from public.community_comment_abuse_policy_states state
        cross join lateral (
          select policy.window_seconds, policy.max_actions,
            policy.cooldown_seconds, policy.turnstile_after
          from public.community_comment_abuse_policies policy
          where policy.action = state.action
          order by policy.policy_version desc limit 1
        ) source
        where state.action = ${quote(action)};
      `)
    : await runJson(databaseUrl, `
        select public.manage_community_comment_abuse_policy(
          ${quote(adminSession)}::uuid, ${quote(action)}, state.state_version, false,
          null, null, null, null, ${quote(randomUUID())}::uuid
        )
        from public.community_comment_abuse_policy_states state
        where state.action = ${quote(action)} and state.active_policy_version is not null;
      `);
  const expected = activate ? "activated" : "deactivated";
  if (result?.outcome !== expected) throw new Error(`DEV ${action} policy did not become ${expected}.`);
}

async function setRelease(databaseUrl, adminSession, state) {
  const result = await runJson(databaseUrl, `
    select public.manage_community_comment_release_state(
      ${quote(adminSession)}::uuid, ${quote(state)}, setting.version, ${quote(randomUUID())}::uuid
    ) from public.community_comment_settings setting where singleton;
  `);
  if (!["updated", "unchanged"].includes(result?.outcome) || result.state !== state) {
    throw new Error(`DEV Comment release did not become ${state}.`);
  }
}

const databaseUrl = await loadDevDatabaseUrl();
const baseline = await runJson(databaseUrl, `
  select json_build_object(
    'releaseState', public.get_community_comment_release_state(),
    'activePolicies', (select count(*) from public.community_comment_abuse_policy_states where active_policy_version is not null),
    'activeSpam', (select count(*) from public.community_comment_spam_policy_state where active_policy_version is not null),
    'replyEvents', (select count(*) from public.notification_events where event_type = 'comment_reply'),
    'mentionEvents', (select count(*) from public.notification_events where event_type = 'comment_mention')
  );
`);
if (baseline.releaseState !== "off" || baseline.activePolicies !== 0 || baseline.activeSpam !== 0) {
  throw new Error("DEV notification concurrency requires the fail-closed baseline.");
}

const adminSession = await ownerSession(databaseUrl);
const [author, replyTarget, mentionTarget] = await actors(databaseUrl);
if (!adminSession || !author || !replyTarget || !mentionTarget) {
  throw new Error("DEV notification concurrency requires one owner and three Website actors.");
}
const submissionId = Number(await runSql(databaseUrl, `
  select submission_id from public.community_comment_threads thread
  where public.is_community_comment_submission_eligible(thread.submission_id)
  order by submission_id limit 1;
`));
if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
  throw new Error("DEV notification concurrency has no eligible Submission.");
}

let cleanupError = null;
try {
  await setPolicy(databaseUrl, adminSession, "root", true);
  await setPolicy(databaseUrl, adminSession, "reply", true);
  await setRelease(databaseUrl, adminSession, "open");

  const threadVersion = Number(await runSql(databaseUrl, `
    select version from public.community_comment_threads where submission_id = ${submissionId};
  `));
  const rootBody = "Fantasy notification concurrency root";
  const root = await runJson(databaseUrl, `
    select public.create_community_comment_root(
      ${quote(replyTarget.sessionId)}::uuid, ${submissionId}, ${threadVersion},
      ${quote(rootBody)}, '[]'::jsonb, ${quote(randomUUID())}::uuid,
      ${quote(digest(rootBody))}, false
    );
  `);
  if (root.outcome !== "created") throw new Error("DEV notification concurrency root failed.");
  const rootPublicCommentId = root.comment.publicCommentId;

  const inputs = Array.from({ length: 10 }, (_, index) => {
    const body = `Fantasy parallel mention @target ${index}`;
    return { body, requestId: randomUUID() };
  });
  const replies = await Promise.all(inputs.map((input) => runJson(databaseUrl, `
    select public.create_community_comment_reply(
      ${quote(author.sessionId)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      1, 1, ${quote(input.body)},
      jsonb_build_array(jsonb_build_object(
        'targetPublicProfileId', ${quote(mentionTarget.profileId)}::uuid,
        'startIndex', 25, 'endIndex', 32
      )),
      ${quote(input.requestId)}::uuid, ${quote(digest(input.body))}, false
    );
  `)));
  if (replies.some((reply) => reply.outcome !== "created" || reply.replayed !== false)) {
    throw new Error("One parallel DEV Reply failed.");
  }

  const replays = await Promise.all(inputs.map((input) => runJson(databaseUrl, `
    select public.create_community_comment_reply(
      ${quote(author.sessionId)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      1, 1, ${quote(input.body)},
      jsonb_build_array(jsonb_build_object(
        'targetPublicProfileId', ${quote(mentionTarget.profileId)}::uuid,
        'startIndex', 25, 'endIndex', 32
      )),
      ${quote(input.requestId)}::uuid, ${quote(digest(input.body))}, false
    );
  `)));
  if (replays.some((reply) => reply.outcome !== "created" || reply.replayed !== true)) {
    throw new Error("One parallel DEV Reply replay was not stable.");
  }

  const publicIds = replies.map((reply) => quote(reply.comment.publicCommentId)).join(",");
  const evidence = await runJson(databaseUrl, `
    with scoped_comments as (
      select id, public_comment_id from public.community_comments
      where public_comment_id = any(array[${publicIds}]::uuid[])
    ), scoped_lifecycle as (
      select lifecycle.id
      from public.community_comment_mention_lifecycle lifecycle
      join scoped_comments comment_row on comment_row.id = lifecycle.comment_id
      where lifecycle.target_discord_user_id = ${quote(mentionTarget.actor)}
    ), scoped_events as (
      select event.* from public.notification_events event
      where event.producer_key in (
        select 'comment-reply:' || public_comment_id::text from scoped_comments
        union all
        select 'comment-mention:' || id::text from scoped_lifecycle
      )
    )
    select json_build_object(
      'comments', (select count(*) from scoped_comments),
      'lifecycles', (select count(*) from scoped_lifecycle),
      'replyEvents', (select count(*) from scoped_events where event_type = 'comment_reply' and owner_discord_user_id = ${quote(replyTarget.actor)}),
      'mentionEvents', (select count(*) from scoped_events where event_type = 'comment_mention' and owner_discord_user_id = ${quote(mentionTarget.actor)}),
      'accountNotifications', (select count(*) from public.account_notifications notification join scoped_events event on event.id = notification.event_id),
      'pushJobs', (select count(*) from public.push_delivery_jobs job join scoped_events event on event.id = job.event_id),
      'requests', (select count(*) from public.community_comment_mutation_requests request where request.request_id = any(array[${inputs.map((input) => quote(input.requestId)).join(",")}]::uuid[]))
    );
  `);
  if (evidence.comments !== 10 || evidence.lifecycles !== 10 ||
      evidence.replyEvents !== 10 || evidence.mentionEvents !== 10 ||
      evidence.accountNotifications !== 20 || evidence.pushJobs !== 0 || evidence.requests !== 10) {
    throw new Error("DEV notification concurrency exact-once evidence failed.");
  }

  console.log(JSON.stringify({
    result: "my_comments_mentions_notification_concurrency_ok",
    parallelReplies: 10,
    replyEvents: 10,
    mentionEvents: 10,
    accountNotifications: 20,
    pushJobsDefaultOff: 0,
    exactOnceReplays: 10,
  }));
} finally {
  try { await setRelease(databaseUrl, adminSession, "off"); } catch (error) { cleanupError ??= error; }
  for (const action of ["reply", "root"]) {
    try { await setPolicy(databaseUrl, adminSession, action, false); } catch (error) { cleanupError ??= error; }
  }
}

if (cleanupError) throw cleanupError;
const finalState = await runJson(databaseUrl, `
  select json_build_object(
    'releaseState', public.get_community_comment_release_state(),
    'activePolicies', (select count(*) from public.community_comment_abuse_policy_states where active_policy_version is not null),
    'activeSpam', (select count(*) from public.community_comment_spam_policy_state where active_policy_version is not null)
  );
`);
if (finalState.releaseState !== "off" || finalState.activePolicies !== 0 || finalState.activeSpam !== 0) {
  throw new Error("DEV notification concurrency cleanup did not restore fail-closed state.");
}
