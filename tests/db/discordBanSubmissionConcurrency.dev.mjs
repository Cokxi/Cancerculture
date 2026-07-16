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
const cycleId = Number(8_200_000_000n + (runSeed % 500_000_000n));
const submissionBase = Number(
  8_800_000_000n + (runSeed % 100_000_000n) * 10n
);
const discordBase =
  991_000_000_000_000_000n + (runSeed % 8_000_000_000_000_000n);
const targetUser = String(discordBase + 1n);
const voterUser = String(discordBase + 2n);
const otherUser = String(discordBase + 3n);
const adminUser = String(discordBase + 99n);
const targetSubmission = submissionBase + 1;
const otherSubmission = submissionBase + 2;
const prefix = `ban-sub-concurrency-${runId}-`;
const targetStorageUuid = randomUUID();
const otherStorageUuid = randomUUID();
let databaseUrl;

async function readEnvFile(name) {
  const values = new Map();
  const source = await readFile(path.join(repoRoot, name), "utf8");
  for (const line of source.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values.set(
      line.slice(0, separator).trim(),
      line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, "$2")
    );
  }
  return values;
}

function projectRef(databaseUrlValue) {
  const parsed = new URL(databaseUrlValue);
  return (
    parsed.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ??
    null
  );
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([
    readEnvFile(".env.local"),
    readEnvFile(".env.codex.local"),
  ]);
  const databaseUrlValue =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    codex.get("SUPABASE_DEV_DATABASE_URL");
  const websiteUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    local.get("NEXT_PUBLIC_SUPABASE_URL");
  if (!databaseUrlValue || !websiteUrl) {
    throw new Error("Required DEV configuration is missing");
  }
  if (
    projectRef(databaseUrlValue) !==
    new URL(websiteUrl).hostname.split(".")[0]
  ) {
    throw new Error("Refusing to run against a non-matching database project");
  }
  return databaseUrlValue;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(source, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [
        databaseUrl,
        "-X",
        "-q",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        source,
      ],
      { windowsHide: true }
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
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: stdout.trim() });
      } else {
        reject(new Error("A sanitized DEV database command failed"));
      }
    });
  });
}

async function scalar(source) {
  return (await runSql(source)).stdout;
}

async function cleanup() {
  await runSql(`
    delete from public.discord_membership_sync_events
    where event_id like ${literal(`${prefix}%`)};
    delete from public.admin_action_logs
    where target_id in (
      ${literal(targetUser)},
      ${literal(voterUser)},
      ${literal(otherUser)},
      ${literal(targetSubmission)},
      ${literal(otherSubmission)},
      ${literal(cycleId)}
    );
    delete from public.media_cleanup_queue
    where storage_key like ${literal(`${cycleId}/%`)};
    delete from public.winner_public_profiles where cycle_id = ${cycleId};
    delete from public.cycle_results where cycle_id = ${cycleId};
    delete from public.votes where cycle_id = ${cycleId};
    delete from public.submission_private_data
    where submission_id in (${targetSubmission}, ${otherSubmission});
    delete from public.submissions where cycle_id = ${cycleId};
    delete from public.cycle_events where cycle_id = ${cycleId};
    delete from public.cycle_reminders where cycle_id = ${cycleId};
    delete from public.user_cycle_acceptance where cycle_id = ${cycleId};
    delete from public.cycle_sponsorships where cycle_id = ${cycleId};
    delete from public.voting_cycles where id = ${cycleId};
    delete from public.sessions
    where discord_user_id in (
      ${literal(targetUser)},
      ${literal(voterUser)},
      ${literal(otherUser)},
      ${literal(adminUser)}
    );
    delete from public.team_members where discord_user_id = ${literal(adminUser)};
    delete from public.discord_member_state
    where discord_user_id in (
      ${literal(targetUser)},
      ${literal(voterUser)},
      ${literal(otherUser)},
      ${literal(adminUser)}
    );
    delete from public.user_logs
    where discord_user_id in (
      ${literal(targetUser)},
      ${literal(voterUser)},
      ${literal(otherUser)},
      ${literal(adminUser)}
    );
    delete from public.media_cleanup_queue
    where storage_key like ${literal(`${cycleId}/%`)};
  `);
}

async function setup(status) {
  await cleanup();

  await runSql(`
    insert into public.voting_cycles (
      id,
      status,
      starts_at,
      submission_starts_at,
      voting_starts_at
    ) values (
      ${cycleId},
      ${literal(status)},
      transaction_timestamp() - interval '2 hours',
      transaction_timestamp() - interval '2 hours',
      transaction_timestamp() - interval '1 hour'
    );

    insert into public.user_logs (
      discord_user_id,
      current_discord_username
    ) values
      (${literal(targetUser)}, 'concurrency-target'),
      (${literal(voterUser)}, 'concurrency-voter'),
      (${literal(otherUser)}, 'concurrency-other'),
      (${literal(adminUser)}, 'concurrency-admin');

    insert into public.discord_member_state (
      discord_user_id,
      current_discord_username,
      discord_joined_at,
      is_in_discord,
      discord_ban_active,
      discord_membership_observed_at
    ) values
      (
        ${literal(targetUser)},
        'concurrency-target',
        transaction_timestamp() - interval '1 day',
        true,
        false,
        transaction_timestamp() - interval '1 day'
      ),
      (
        ${literal(voterUser)},
        'concurrency-voter',
        transaction_timestamp() - interval '1 day',
        true,
        false,
        transaction_timestamp() - interval '1 day'
      ),
      (
        ${literal(otherUser)},
        'concurrency-other',
        transaction_timestamp() - interval '1 day',
        true,
        false,
        transaction_timestamp() - interval '1 day'
      ),
      (
        ${literal(adminUser)},
        'concurrency-admin',
        transaction_timestamp() - interval '1 day',
        true,
        false,
        transaction_timestamp() - interval '1 day'
      );

    insert into public.team_members (
      discord_user_id,
      role,
      discord_username
    ) values (
      ${literal(adminUser)},
      'admin',
      'concurrency-admin'
    );

    insert into public.submissions (
      id,
      cycle_id,
      discord_user_id,
      r2_key,
      discord_username_at_upload
    ) values
      (
        ${targetSubmission},
        ${cycleId},
        ${literal(targetUser)},
        ${literal(`${cycleId}/${targetStorageUuid}.webp`)},
        'concurrency-target'
      ),
      (
        ${otherSubmission},
        ${cycleId},
        ${literal(otherUser)},
        ${literal(`${cycleId}/${otherStorageUuid}.webp`)},
        'concurrency-other'
      );

    insert into public.submission_private_data (
      submission_id,
      wallet_address,
      payout_choice
    ) values
      (${targetSubmission}, 'wallet-target', 'keep'),
      (${otherSubmission}, 'wallet-other', 'keep');
  `);
}

function banSql(eventId) {
  return `
    select public.apply_discord_ban(
      ${literal(eventId)},
      transaction_timestamp(),
      repeat('a', 64),
      ${literal(targetUser)},
      'concurrency-target'
    )::text;
  `;
}

async function assertHiddenAndBanned() {
  const state = await scalar(`
    select
      member.discord_ban_active::text || ':' ||
      submission.public_visibility_status || ':' ||
      coalesce(submission.is_disqualified, false)::text
    from public.discord_member_state member
    join public.submissions submission
      on submission.discord_user_id = member.discord_user_id
    where member.discord_user_id = ${literal(targetUser)}
      and submission.id = ${targetSubmission};
  `);

  if (state !== "true:removed:true") {
    throw new Error("Concurrent operation left an unsafe Ban/Submission state");
  }
}

async function testBanAndVote() {
  await setup("voting_open");

  const [ban, vote] = await Promise.all([
    runSql(banSql(`${prefix}vote-ban`)),
    runSql(
      `
        select public.cast_cycle_vote(
          ${cycleId},
          ${targetSubmission},
          ${literal(voterUser)}
        )::text;
      `,
      { allowFailure: true }
    ),
  ]);

  if (ban.code !== 0 || ![0, 1, 3].includes(vote.code)) {
    throw new Error("Ban/Vote concurrency returned an unexpected result");
  }

  await assertHiddenAndBanned();
}

async function testBanAndFinalization() {
  await setup("voting_closed");

  const [ban, finalization] = await Promise.all([
    runSql(banSql(`${prefix}finalize-ban`)),
    runSql(`
      select public.finalize_cycle(
        ${cycleId},
        ${literal(adminUser)}
      )::text;
    `),
  ]);

  if (ban.code !== 0 || finalization.code !== 0) {
    throw new Error("Ban/Finalization concurrency failed");
  }

  const result = await scalar(`
    select
      cycle.status::text || ':' ||
      submission.public_visibility_status || ':' ||
      coalesce(submission.is_disqualified, false)::text || ':' ||
      exists(
        select 1 from public.cycle_results result
        where result.cycle_id = ${cycleId}
          and result.submission_id = ${targetSubmission}
      )::text
    from public.voting_cycles cycle
    join public.submissions submission
      on submission.id = ${targetSubmission}
    where cycle.id = ${cycleId};
  `);

  if (
    result !== "finished:removed:true:false" &&
    result !== "finished:removed:false:true"
  ) {
    throw new Error("Ban/Finalization was not cleanly serialized");
  }
}

async function testBanAndReset() {
  await setup("submission_open");

  const [ban, reset] = await Promise.all([
    runSql(banSql(`${prefix}reset-ban`)),
    runSql(`
      select public.reset_cycle(
        ${cycleId},
        ${literal(adminUser)},
        'Concurrency reset verification'
      )::text;
    `),
  ]);

  if (ban.code !== 0 || reset.code !== 0) {
    throw new Error("Ban/Reset concurrency failed");
  }

  const result = await scalar(`
    select status::text || ':' ||
      exists(
        select 1 from public.submissions
        where cycle_id = ${cycleId}
      )::text
    from public.voting_cycles
    where id = ${cycleId};
  `);

  if (result !== "draft:false") {
    throw new Error("Ban/Reset did not leave the canonical reset state");
  }
}

async function testBanAndRepublish() {
  await setup("finished");

  await runSql(banSql(`${prefix}republish-initial-ban`));
  await runSql(`
    select public.apply_discord_unban(
      ${literal(`${prefix}republish-unban`)},
      transaction_timestamp(),
      repeat('b', 64),
      ${literal(targetUser)},
      'concurrency-target'
    )::text;
  `);

  const [ban, republish] = await Promise.all([
    runSql(banSql(`${prefix}republish-race-ban`)),
    runSql(
      `
        select public.republish_discord_ban_submission(
          ${targetSubmission},
          ${literal(adminUser)},
          'Concurrent manual review confirmation.',
          true
        )::text;
      `,
      { allowFailure: true }
    ),
  ]);

  if (ban.code !== 0 || ![0, 1, 3].includes(republish.code)) {
    throw new Error("Ban/Republish concurrency returned an unexpected result");
  }

  const result = await scalar(`
    select member.discord_ban_active::text || ':' ||
      submission.public_visibility_status
    from public.discord_member_state member
    join public.submissions submission
      on submission.discord_user_id = member.discord_user_id
    where member.discord_user_id = ${literal(targetUser)}
      and submission.id = ${targetSubmission};
  `);

  if (result !== "true:removed") {
    throw new Error("Concurrent republish bypassed the newer active Ban");
  }
}

databaseUrl = await loadDevDatabaseUrl();
await cleanup();

const currentCycleCount = Number(
  await scalar(`
    select count(*) from public.voting_cycles
    where status::text in (
      'active',
      'submission_open',
      'submission_closed',
      'voting_open',
      'voting_closed',
      'paused',
      'finalizing'
    );
  `)
);

if (currentCycleCount !== 0) {
  throw new Error(
    "DEV_BAN_SUBMISSION_CONCURRENCY_REQUIRES_NO_CURRENT_CYCLE"
  );
}

const baseline = await scalar(`
  select
    (select count(*) from public.submissions)::text || ':' ||
    (select count(*) from public.cycle_results)::text || ':' ||
    (select count(*) from public.media_cleanup_queue)::text;
`);

try {
  await testBanAndVote();
  await testBanAndFinalization();
  await testBanAndReset();
  await testBanAndRepublish();
  console.log("DEV Discord Ban/Submission concurrency tests passed.");
} finally {
  await cleanup();
}

const after = await scalar(`
  select
    (select count(*) from public.submissions)::text || ':' ||
    (select count(*) from public.cycle_results)::text || ':' ||
    (select count(*) from public.media_cleanup_queue)::text;
`);

if (after !== baseline) {
  throw new Error("Historical DEV aggregate state changed during concurrency tests");
}

console.log("DEV Discord Ban/Submission concurrency cleanup passed.");
