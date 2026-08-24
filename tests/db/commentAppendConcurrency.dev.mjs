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
    throw new Error("Refusing to run Comment append concurrency outside DEV.");
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
    child.on("error", () => reject(new Error("The DEV append concurrency command could not start.")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr
        .replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500);
      reject(new Error(`Sanitized DEV append concurrency SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

async function runJson(databaseUrl, sql) {
  const value = await runSql(databaseUrl, sql);
  return JSON.parse(value);
}

async function currentState(databaseUrl) {
  return runJson(databaseUrl, `
    select json_build_object(
      'releaseState', (select release_state from public.community_comment_settings where singleton),
      'releaseVersion', (select version from public.community_comment_settings where singleton),
      'activePolicies', (select count(*) from public.community_comment_abuse_policy_states where active_policy_version is not null),
      'activeSpam', (select count(*) from public.community_comment_spam_policy_state where active_policy_version is not null),
      'comments', (select count(*) from public.community_comments),
      'mutationEvents', (select count(*) from public.community_comment_mutation_events),
      'abuseAppendEvents', (select count(*) from public.community_comment_abuse_events where action in ('root','reply')),
      'spamEvents', (select count(*) from public.community_comment_spam_events)
    );
  `);
}

async function ownerSession(databaseUrl) {
  return runSql(databaseUrl, `
    select session_row.id
    from public.sessions session_row
    join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
    join public.team_members member on member.discord_user_id = session_row.discord_user_id
    left join public.discord_member_state member_state on member_state.discord_user_id = session_row.discord_user_id
    where session_row.revoked_at is null
      and member.role = 'admin'
      and not user_log.is_banned
      and not coalesce(member_state.discord_ban_active, false)
    order by session_row.created_at desc
    limit 1;
  `);
}

async function actorSessions(databaseUrl) {
  return runJson(databaseUrl, `
    select coalesce(json_agg(json_build_object('sessionId', selected.id, 'actor', selected.discord_user_id)), '[]'::json)
    from (
      select distinct on (session_row.discord_user_id)
        session_row.id, session_row.discord_user_id
      from public.sessions session_row
      join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
      left join public.discord_member_state member_state on member_state.discord_user_id = session_row.discord_user_id
      where session_row.revoked_at is null
        and user_log.public_profile_id is not null
        and not user_log.is_banned
        and not coalesce(member_state.discord_ban_active, false)
      order by session_row.discord_user_id, session_row.created_at desc
      limit 5
    ) selected;
  `);
}

async function setActionPolicy(databaseUrl, sessionId, action, activate) {
  const requestId = randomUUID();
  const result = activate
    ? await runJson(databaseUrl, `
        select public.manage_community_comment_abuse_policy(
          ${quote(sessionId)}::uuid,
          ${quote(action)},
          state.state_version,
          true,
          source.window_seconds,
          source.max_actions,
          source.cooldown_seconds,
          source.turnstile_after,
          ${quote(requestId)}::uuid
        )
        from public.community_comment_abuse_policy_states state
        cross join lateral (
          select policy.window_seconds, policy.max_actions,
            policy.cooldown_seconds, policy.turnstile_after
          from public.community_comment_abuse_policies policy
          where policy.action = state.action
          order by policy.policy_version desc
          limit 1
        ) source
        where state.action = ${quote(action)};
      `)
    : await runJson(databaseUrl, `
        select public.manage_community_comment_abuse_policy(
          ${quote(sessionId)}::uuid,
          ${quote(action)},
          state.state_version,
          false,
          null, null, null, null,
          ${quote(requestId)}::uuid
        )
        from public.community_comment_abuse_policy_states state
        where state.action = ${quote(action)} and state.active_policy_version is not null;
      `);
  if (!result || ![activate ? "activated" : "deactivated"].includes(result.outcome)) {
    throw new Error(`DEV ${action} policy did not ${activate ? "activate" : "deactivate"}.`);
  }
}

async function setRelease(databaseUrl, sessionId, state) {
  const result = await runJson(databaseUrl, `
    select public.manage_community_comment_release_state(
      ${quote(sessionId)}::uuid,
      ${quote(state)},
      setting.version,
      ${quote(randomUUID())}::uuid
    )
    from public.community_comment_settings setting where singleton;
  `);
  if (!result || !["updated", "unchanged"].includes(result.outcome) || result.state !== state) {
    throw new Error(`DEV Comment release did not become ${state}.`);
  }
}

async function appendRoot(databaseUrl, input) {
  return runJson(databaseUrl, `
    select public.create_community_comment_root(
      ${quote(input.sessionId)}::uuid,
      ${input.submissionId},
      ${input.expectedThreadVersion},
      ${quote(input.body)},
      '[]'::jsonb,
      ${quote(input.requestId)}::uuid,
      ${quote(digest(input.body))},
      false
    );
  `);
}

async function appendReply(databaseUrl, input) {
  return runJson(databaseUrl, `
    select public.create_community_comment_reply(
      ${quote(input.sessionId)}::uuid,
      ${quote(input.rootPublicCommentId)}::uuid,
      ${quote(input.rootPublicCommentId)}::uuid,
      1,
      1,
      ${quote(input.body)},
      '[]'::jsonb,
      ${quote(input.requestId)}::uuid,
      ${quote(digest(input.body))},
      false
    );
  `);
}

const databaseUrl = await loadDevDatabaseUrl();
const before = await currentState(databaseUrl);
if (before.releaseState !== "off" || before.activePolicies !== 0 || before.activeSpam !== 0) {
  throw new Error("DEV Comment append concurrency requires the fail-closed baseline.");
}
const adminSession = await ownerSession(databaseUrl);
const actors = await actorSessions(databaseUrl);
if (!adminSession || actors.length !== 5) {
  throw new Error("DEV Comment append concurrency requires one owner and five valid Website actors.");
}
const submissionId = Number(await runSql(databaseUrl, `
  select submission_id
  from public.community_comment_threads thread
  where public.is_community_comment_submission_eligible(thread.submission_id)
  order by case when submission_id = 354 then 0 else 1 end, submission_id
  limit 1;
`));
if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
  throw new Error("No eligible DEV Submission is available for Comment append concurrency.");
}

let cleanupError = null;
try {
  for (const action of ["root", "reply", "edit"]) {
    await setActionPolicy(databaseUrl, adminSession, action, true);
  }
  await setRelease(databaseUrl, adminSession, "open");

  const baselineThreadVersion = Number(await runSql(databaseUrl, `
    select version from public.community_comment_threads where submission_id = ${submissionId};
  `));
  const rootInputs = Array.from({ length: 10 }, (_, index) => ({
    sessionId: actors[index % actors.length].sessionId,
    submissionId,
    expectedThreadVersion: baselineThreadVersion,
    requestId: randomUUID(),
    body: `Fantasy concurrency Root ${randomUUID()}`,
  }));
  const rootResults = await Promise.all(rootInputs.map((input) => appendRoot(databaseUrl, input)));
  if (rootResults.some((result) => result.outcome !== "created" || result.replayed !== false)) {
    throw new Error("Not every parallel Root append succeeded exactly once.");
  }
  const rootReplays = await Promise.all(rootInputs.map((input) => appendRoot(databaseUrl, input)));
  if (rootReplays.some((result) => result.outcome !== "created" || result.replayed !== true)) {
    throw new Error("Parallel Root replay was not stable and idempotent.");
  }

  const rootPublicCommentId = rootResults[0].comment.publicCommentId;
  const replyInputs = Array.from({ length: 10 }, (_, index) => ({
    sessionId: actors[index % actors.length].sessionId,
    rootPublicCommentId,
    requestId: randomUUID(),
    body: `Fantasy concurrency Reply ${randomUUID()}`,
  }));
  const replyResults = await Promise.all(replyInputs.map((input) => appendReply(databaseUrl, input)));
  if (replyResults.some((result) => result.outcome !== "created" || result.replayed !== false)) {
    throw new Error("Not every parallel Reply append succeeded exactly once.");
  }
  const replyReplays = await Promise.all(replyInputs.map((input) => appendReply(databaseUrl, input)));
  if (replyReplays.some((result) => result.outcome !== "created" || result.replayed !== true)) {
    throw new Error("Parallel Reply replay was not stable and idempotent.");
  }

  const authorSession = rootInputs[0].sessionId;
  const editedBody = `Fantasy concurrency edited Root ${randomUUID()}`;
  const editSuccess = await runJson(databaseUrl, `
    select public.edit_community_comment(
      ${quote(authorSession)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      1,
      ${quote(editedBody)},
      '[]'::jsonb,
      ${quote(randomUUID())}::uuid,
      ${quote(digest(editedBody))},
      false
    );
  `);
  const staleEditBody = `Fantasy stale edit ${randomUUID()}`;
  const staleEdit = await runJson(databaseUrl, `
    select public.edit_community_comment(
      ${quote(authorSession)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      1,
      ${quote(staleEditBody)},
      '[]'::jsonb,
      ${quote(randomUUID())}::uuid,
      ${quote(digest(staleEditBody))},
      false
    );
  `);
  if (editSuccess.outcome !== "edited" || staleEdit.outcome !== "stale_comment") {
    throw new Error("Edit conflict did not remain fail-closed.");
  }

  const deleteRequests = [randomUUID(), randomUUID()];
  const deleteResults = await Promise.all(deleteRequests.map((requestId) => runJson(databaseUrl, `
    select public.delete_community_comment(
      ${quote(authorSession)}::uuid,
      ${quote(rootPublicCommentId)}::uuid,
      2,
      ${quote(requestId)}::uuid,
      true
    );
  `)));
  if (
    deleteResults.filter((result) => result.outcome === "author_deleted").length !== 1 ||
    deleteResults.filter((result) => result.outcome === "stale_comment").length !== 1
  ) {
    throw new Error("Delete conflict did not serialize to one success and one stale result.");
  }
  const closedReply = await appendReply(databaseUrl, {
    sessionId: actors[1].sessionId,
    rootPublicCommentId,
    requestId: randomUUID(),
    body: `Fantasy closed-branch Reply ${randomUUID()}`,
  });
  if (closedReply.outcome !== "branch_closed") {
    throw new Error("Author-deleted Root accepted a new Reply.");
  }

  const appendRequestIds = [...rootInputs, ...replyInputs].map((input) => input.requestId);
  const requestArray = `array[${appendRequestIds.map(quote).join(",")}]::uuid[]`;
  const after = await currentState(databaseUrl);
  const scoped = await runJson(databaseUrl, `
    select json_build_object(
      'requests', (select count(*) from public.community_comment_mutation_requests where request_id = any(${requestArray})),
      'events', (select count(*) from public.community_comment_mutation_events where request_id = any(${requestArray})),
      'comments', (select count(*) from public.community_comment_mutation_events where request_id = any(${requestArray}) and event_type = 'created')
    );
  `);
  if (
    scoped.requests !== 20 || scoped.events !== 20 || scoped.comments !== 20 ||
    after.comments - before.comments !== 20 ||
    after.abuseAppendEvents - before.abuseAppendEvents !== 20 ||
    after.spamEvents !== before.spamEvents
  ) {
    throw new Error("Append replay duplicated Comment, abuse, Spam or audit state.");
  }
} finally {
  try {
    const state = await currentState(databaseUrl);
    if (state.releaseState !== "off") await setRelease(databaseUrl, adminSession, "off");
    for (const action of ["edit", "reply", "root"]) {
      const active = Number(await runSql(databaseUrl, `
        select count(*) from public.community_comment_abuse_policy_states
        where action = ${quote(action)} and active_policy_version is not null;
      `));
      if (active === 1) await setActionPolicy(databaseUrl, adminSession, action, false);
    }
  } catch (error) {
    cleanupError = error;
  }
}

if (cleanupError) throw cleanupError;
const finalState = await currentState(databaseUrl);
if (finalState.releaseState !== "off" || finalState.activePolicies !== 0 || finalState.activeSpam !== 0) {
  throw new Error("DEV Comment append concurrency cleanup did not restore fail-closed state.");
}
console.log(JSON.stringify({
  result: "comment_append_concurrency_ok",
  parallelRoots: 10,
  parallelReplies: 10,
  exactOnceRequests: 20,
  exactOnceMutationEvents: 20,
  duplicateAbuseEvents: 0,
  duplicateSpamEvents: 0,
  staleEditFailClosed: true,
  concurrentDeleteFailClosed: true,
  deletedBranchFailClosed: true,
  finalReleaseState: "off",
  finalActivePolicies: 0,
}));
