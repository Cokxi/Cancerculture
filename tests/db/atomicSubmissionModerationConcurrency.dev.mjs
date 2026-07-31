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
const runId = randomUUID();
const runSeed = BigInt(`0x${runId.replaceAll("-", "").slice(0, 12)}`);
const cycleId = Number(1_700_000_000n + (runSeed % 300_000_000n));
const submissionA = Number(2_200_000_000n + (runSeed % 300_000_000n) * 2n);
const submissionB = submissionA + 1;
const userBase = 994_000_000_000_000_000n + (runSeed % 5_000_000_000_000_000n);
const submitterA = String(userBase + 1n);
const submitterB = String(userBase + 2n);
const voter = String(userBase + 3n);
let databaseUrl;
let adminId;
let originalCycleId;
let originalCycleStatus;
let appConfigSnapshot;

async function readEnv(name) {
  const values = new Map();
  const contents = await readFile(path.join(repoRoot, name), "utf8");
  for (const line of contents.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2")
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
  if (!value || !website) throw new Error("Required DEV configuration is missing");
  if (projectRef(value) !== new URL(website).hostname.split(".")[0]) {
    throw new Error("Refusing to run against a non-matching database project");
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
      { windowsHide: true }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
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

function requestSql({ operation, phase, expected, requestId, reason }) {
  const type = operation === "disqualify" ? literal("manual") : "null";
  return `select public.moderate_submission(
    ${literal(adminId)}, ${cycleId}, ${submissionA}, ${literal(operation)},
    ${literal(phase)}, ${expected}, ${type}, 'concurrency_test',
    ${literal(reason)}, ${literal(requestId)}::uuid
  )::text;`;
}

function configRestoreSql() {
  const entries = Object.entries(appConfigSnapshot ?? {});
  const values = entries
    .map(([key, value]) => `(${literal(key)}, ${value === null ? "null" : literal(value)})`)
    .join(",");
  return `
    delete from public.app_config where key in ('cycle_end_at', 'cycle_theme');
    ${values ? `insert into public.app_config (key, value) values ${values};` : ""}
  `;
}

async function cleanupFixture() {
  await runSql(`
    delete from public.submission_moderation_requests
    where request_payload ->> 'cycleId' = ${literal(cycleId)};
    delete from public.moderation_action_logs where cycle_id = ${cycleId};
    delete from public.admin_action_logs
    where target_type = 'cycle' and target_id = ${literal(cycleId)};
    delete from public.media_cleanup_queue
    where reason = ${literal(`cycle_reset:${cycleId}`)};
    delete from public.winner_public_profiles where cycle_id = ${cycleId};
    delete from public.cycle_results where cycle_id = ${cycleId};
    delete from public.votes where cycle_id = ${cycleId};
    delete from public.submission_social_links
    where submission_id in (${submissionA}, ${submissionB});
    delete from public.submission_private_data
    where submission_id in (${submissionA}, ${submissionB});
    delete from public.submissions where cycle_id = ${cycleId};
    delete from public.cycle_events where cycle_id = ${cycleId};
    delete from public.cycle_reminders where cycle_id = ${cycleId};
    delete from public.user_cycle_acceptance where cycle_id = ${cycleId};
    delete from public.cycle_sponsorships where cycle_id = ${cycleId};
    delete from public.voting_cycles where id = ${cycleId};
    delete from public.discord_member_state
    where discord_user_id in (${literal(submitterA)}, ${literal(submitterB)}, ${literal(voter)});
    delete from public.user_logs
    where discord_user_id in (${literal(submitterA)}, ${literal(submitterB)}, ${literal(voter)});
    ${configRestoreSql()}
  `);
}

async function setupFixture(status) {
  await cleanupFixture();
  await runSql(`
    insert into public.voting_cycles (
      id, status, starts_at, submission_starts_at, submission_ends_at,
      voting_starts_at, voting_ends_at, votes_per_user, allow_self_vote
    ) values (
      ${cycleId}, ${literal(status)}, transaction_timestamp() - interval '2 hours',
      transaction_timestamp() - interval '2 hours',
      case when ${literal(status)} = 'submission_open'
        then transaction_timestamp() + interval '1 hour'
        else transaction_timestamp() - interval '1 hour' end,
      case when ${literal(status)} = 'voting_open'
        then transaction_timestamp() - interval '1 hour' end,
      case when ${literal(status)} = 'voting_open'
        then transaction_timestamp() + interval '1 hour' end,
      2, true
    );
    insert into public.user_logs (discord_user_id, current_discord_username)
    values
      (${literal(submitterA)}, 'atomic-concurrency-a'),
      (${literal(submitterB)}, 'atomic-concurrency-b'),
      (${literal(voter)}, 'atomic-concurrency-voter');
    insert into public.discord_member_state (
      discord_user_id, current_discord_username, discord_joined_at,
      is_in_discord, discord_ban_active, discord_membership_observed_at
    ) values
      (${literal(submitterA)}, 'atomic-concurrency-a', transaction_timestamp() - interval '1 day', true, false, transaction_timestamp()),
      (${literal(submitterB)}, 'atomic-concurrency-b', transaction_timestamp() - interval '1 day', true, false, transaction_timestamp()),
      (${literal(voter)}, 'atomic-concurrency-voter', transaction_timestamp() - interval '1 day', true, false, transaction_timestamp());
    insert into public.submissions (
      id, cycle_id, discord_user_id, discord_username_at_upload,
      is_disqualified, public_visibility_status
    ) values
      (${submissionA}, ${cycleId}, ${literal(submitterA)}, 'atomic-concurrency-a', false, 'visible'),
      (${submissionB}, ${cycleId}, ${literal(submitterB)}, 'atomic-concurrency-b', false, 'visible');
    insert into public.submission_private_data (
      submission_id, wallet_address, payout_choice
    ) values
      (${submissionA}, 'atomic-wallet-a', 'keep'),
      (${submissionB}, 'atomic-wallet-b', 'keep');
  `);
}

async function moderationCounts() {
  return scalar(`select
    (select count(*) from public.moderation_action_logs where cycle_id = ${cycleId})::text || ':' ||
    (select count(*) from public.submission_moderation_requests where request_payload ->> 'cycleId' = ${literal(cycleId)})::text;`);
}

async function testParallelDisqualifications() {
  await setupFixture("submission_open");
  const [left, right] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId: randomUUID(), reason: "Parallel DQ left." }), { allowFailure: true }),
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId: randomUUID(), reason: "Parallel DQ right." }), { allowFailure: true }),
  ]);
  if ([left, right].filter((entry) => entry.code === 0).length !== 1) {
    throw new Error("Parallel DQ requests did not serialize to one change");
  }
  if ((await scalar(`select is_disqualified::text from public.submissions where id=${submissionA}`)) !== "true") {
    throw new Error("Parallel DQ did not leave the canonical target state");
  }
  if ((await moderationCounts()) !== "1:1") throw new Error("Parallel DQ duplicated audit or ledger rows");
}

async function testDisqualifyAgainstReinstate() {
  await setupFixture("submission_open");
  const [dq, reinstate] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId: randomUUID(), reason: "DQ versus reinstate." }), { allowFailure: true }),
    runSql(requestSql({ operation: "reinstate", phase: "submission_open", expected: true, requestId: randomUUID(), reason: "Reinstate versus DQ." }), { allowFailure: true }),
  ]);
  const successCount = [dq, reinstate].filter((entry) => entry.code === 0).length;
  const state = await scalar(`select is_disqualified::text from public.submissions where id=${submissionA}`);
  if (![1, 2].includes(successCount) || state !== (successCount === 1 ? "true" : "false")) {
    throw new Error("DQ/Reinstate race was not equivalent to a serial order");
  }
  if ((await moderationCounts()) !== `${successCount}:${successCount}`) {
    throw new Error("DQ/Reinstate race produced duplicate audit or ledger rows");
  }
}

async function testIdenticalParallelRetries() {
  await setupFixture("submission_open");
  const requestId = randomUUID();
  const sql = requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId, reason: "Identical parallel retry." });
  const results = await Promise.all([runSql(sql), runSql(sql)]);
  if (!results.some((entry) => entry.stdout.includes('"replayed": true'))) {
    throw new Error("Identical parallel retry did not replay the stored result");
  }
  if ((await moderationCounts()) !== "1:1") throw new Error("Identical retry duplicated audit or ledger rows");
}

async function testSameKeyDifferentPayload() {
  await setupFixture("submission_open");
  const requestId = randomUUID();
  const [left, right] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId, reason: "Payload A." }), { allowFailure: true }),
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId, reason: "Payload B." }), { allowFailure: true }),
  ]);
  if ([left, right].filter((entry) => entry.code === 0).length !== 1 || (await moderationCounts()) !== "1:1") {
    throw new Error("Same-key payload conflict was not isolated");
  }
}

async function testModerationAgainstTransition() {
  await setupFixture("submission_open");
  await runSql(`update public.voting_cycles set submission_ends_at=transaction_timestamp()-interval '1 second' where id=${cycleId};`);
  const requestId = randomUUID();
  const [moderation, transition] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId, reason: "Moderation versus transition." }), { allowFailure: true }),
    runSql(`select public.process_due_cycle_transitions(${cycleId})::text;`),
  ]);
  const state = await scalar(`select cycle_row.status::text||':'||submission_row.is_disqualified::text
    from public.voting_cycles as cycle_row
    join public.submissions as submission_row
      on submission_row.cycle_id=cycle_row.id
    where cycle_row.id=${cycleId} and submission_row.id=${submissionA};`);
  if (!state.startsWith("voting_open:") || transition.code !== 0) throw new Error("Transition race did not reach voting_open");
  const changed = moderation.code === 0 ? 1 : 0;
  if ((await moderationCounts()) !== `${changed}:${changed}`) throw new Error("Transition race duplicated moderation records");
}

async function testModerationAgainstVoteCast() {
  await setupFixture("voting_open");
  const requestId = randomUUID();
  const [moderation, vote] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "voting_open", expected: false, requestId, reason: "Moderation versus vote." })),
    runSql(`select public.cast_cycle_vote(${cycleId}, ${submissionA}, ${literal(voter)})::text;`, { allowFailure: true }),
  ]);
  const state = await scalar(`select is_disqualified::text||':'||(select count(*) from public.votes where cycle_id=${cycleId} and submission_id=${submissionA})::text from public.submissions where id=${submissionA};`);
  if (moderation.code !== 0 || !["true:0", "true:1"].includes(state)) {
    throw new Error("Vote race did not preserve a valid serialized result");
  }
  if (vote.code === 0 && state !== "true:1") throw new Error("A committed vote was not preserved");
  if ((await moderationCounts()) !== "1:1") throw new Error("Vote race duplicated moderation records");
}

async function testModerationAgainstFinalization() {
  await setupFixture("voting_open");
  const requestId = randomUUID();
  const [moderation, finalization] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "voting_open", expected: false, requestId, reason: "Moderation versus finalization." }), { allowFailure: true }),
    runSql(`begin;
      update public.voting_cycles set voting_ends_at=transaction_timestamp()-interval '1 second' where id=${cycleId};
      select public.process_due_cycle_transitions(${cycleId})::text;
      select public.finalize_cycle(${cycleId}, ${literal(adminId)})::text;
      commit;`),
  ]);
  if (finalization.code !== 0 || (await scalar(`select status::text from public.voting_cycles where id=${cycleId}`)) !== "finished") {
    throw new Error("Finalization race did not complete");
  }
  const moderationChanged = moderation.code === 0 ? 1 : 0;
  if ((await moderationCounts()) !== `${moderationChanged}:${moderationChanged}`) {
    throw new Error("Finalization race duplicated moderation records");
  }
  const targetResult = Number(await scalar(`select count(*) from public.cycle_results where cycle_id=${cycleId} and submission_id=${submissionA};`));
  if (moderationChanged === 1 && targetResult !== 0) {
    throw new Error("Finalization included a disqualified submission");
  }
}

async function testModerationAgainstReset() {
  await setupFixture("submission_open");
  const requestId = randomUUID();
  const [moderation, reset] = await Promise.all([
    runSql(requestSql({ operation: "disqualify", phase: "submission_open", expected: false, requestId, reason: "Moderation versus reset." }), { allowFailure: true }),
    runSql(`select public.reset_cycle(${cycleId}, ${literal(adminId)}, 'Atomic moderation concurrency reset.')::text;`),
  ]);
  const resetState = await scalar(`select status::text||':'||(select count(*) from public.submissions where cycle_id=${cycleId})::text from public.voting_cycles where id=${cycleId};`);
  if (reset.code !== 0 || resetState !== "draft:0") throw new Error("Reset race did not leave canonical draft state");
  const moderationChanged = moderation.code === 0 ? 1 : 0;
  if ((await moderationCounts()) !== `${moderationChanged}:${moderationChanged}`) {
    throw new Error("Reset race duplicated moderation records");
  }
}

async function testVoteEligibilityAndReinstatement() {
  await setupFixture("voting_open");
  await runSql(requestSql({
    operation: "disqualify",
    phase: "voting_open",
    expected: false,
    requestId: randomUUID(),
    reason: "Verify DQ vote barrier.",
  }));
  const rejectedVote = await runSql(
    `select public.cast_cycle_vote(${cycleId}, ${submissionA}, ${literal(voter)})::text;`,
    { allowFailure: true }
  );
  if (rejectedVote.code === 0) throw new Error("Vote cast accepted a disqualified submission");
  await runSql(requestSql({
    operation: "reinstate",
    phase: "voting_open",
    expected: true,
    requestId: randomUUID(),
    reason: "Verify reinstatement reactivates vote eligibility.",
  }));
  await runSql(`select public.cast_cycle_vote(${cycleId}, ${submissionA}, ${literal(voter)})::text;`);
  if ((await scalar(`select count(*) from public.votes where cycle_id=${cycleId} and submission_id=${submissionA};`)) !== "1") {
    throw new Error("Reinstatement did not restore vote eligibility");
  }
}

async function testFinalizationExcludesDisqualifiedSubmission() {
  await setupFixture("voting_open");
  await runSql(requestSql({
    operation: "disqualify",
    phase: "voting_open",
    expected: false,
    requestId: randomUUID(),
    reason: "Verify finalization exclusion.",
  }));
  await runSql(`update public.voting_cycles set status='voting_closed', voting_ends_at=transaction_timestamp() where id=${cycleId};`);
  await runSql(`select public.finalize_cycle(${cycleId}, ${literal(adminId)})::text;`);
  const resultState = await scalar(`select
    (select count(*) from public.cycle_results where cycle_id=${cycleId} and submission_id=${submissionA})::text||':'||
    (select count(*) from public.cycle_results where cycle_id=${cycleId} and submission_id=${submissionB})::text;`);
  if (resultState !== "0:1") throw new Error("Finalization did not exclude the disqualified submission");
}

databaseUrl = await loadDevDatabaseUrl();
const current = await scalar(`select id::text||':'||status::text from public.voting_cycles where status::text in ('active','submission_open','submission_closed','voting_open','voting_closed','paused','finalizing') order by id;`);
if (!/^\d+:[a-z_]+$/u.test(current)) throw new Error("DEV must have exactly one unambiguous current cycle");
[originalCycleId, originalCycleStatus] = current.split(":");
adminId = await scalar(`select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;`);
if (!adminId) throw new Error("DEV admin actor is unavailable");
appConfigSnapshot = JSON.parse(await scalar(`select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)::text from public.app_config where key in ('cycle_end_at','cycle_theme');`));
const baseline = await scalar(`select
  (select count(*) from public.submissions)::text||':'||
  (select count(*) from public.votes)::text||':'||
  (select count(*) from public.moderation_action_logs)::text||':'||
  (select count(*) from public.submission_moderation_requests)::text||':'||
  (select count(*) from public.team_role_capabilities)::text;`);

try {
  await runSql(`update public.voting_cycles set status='draft' where id=${originalCycleId};`);
  await testParallelDisqualifications();
  await testDisqualifyAgainstReinstate();
  await testIdenticalParallelRetries();
  await testSameKeyDifferentPayload();
  await testModerationAgainstTransition();
  await testModerationAgainstVoteCast();
  await testModerationAgainstFinalization();
  await testModerationAgainstReset();
  await testVoteEligibilityAndReinstatement();
  await testFinalizationExcludesDisqualifiedSubmission();
  console.log("DEV atomic submission moderation concurrency tests passed.");
} finally {
  await cleanupFixture();
  await runSql(`update public.voting_cycles set status=${literal(originalCycleStatus)} where id=${originalCycleId};`);
}

const after = await scalar(`select
  (select count(*) from public.submissions)::text||':'||
  (select count(*) from public.votes)::text||':'||
  (select count(*) from public.moderation_action_logs)::text||':'||
  (select count(*) from public.submission_moderation_requests)::text||':'||
  (select count(*) from public.team_role_capabilities)::text;`);
const restoredCycle = await scalar(`select status::text from public.voting_cycles where id=${originalCycleId};`);
if (after !== baseline || restoredCycle !== originalCycleStatus) {
  throw new Error("DEV aggregate or current-cycle state changed during concurrency tests");
}
console.log("DEV atomic submission moderation concurrency cleanup passed.");
