import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const devProjectRef = "gceljiuydyiwkomymuqh";
const testCycleIds = [2000010301, 2000010302, 2000010303, 2000010304];
const configKeys = [
  "cycle_theme",
  "next_cycle_theme",
  "next_cycle_reward_description",
  "next_cycle_sponsored_enabled",
  "next_cycle_sponsor_name",
  "next_cycle_sponsor_link",
  "next_cycle_sponsor_banner_r2_key",
  "next_cycle_is_sponsored",
];
const appConfigBackup = "_codex_cycle_concurrency_app_config_backup";
const userLogBackup = "_codex_cycle_concurrency_user_log_backup";

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readDevDatabaseUrl() {
  if (process.env.SUPABASE_DEV_DATABASE_URL) {
    return process.env.SUPABASE_DEV_DATABASE_URL;
  }

  const dotenv = await readFile(path.join(repoRoot, ".env.codex.local"), "utf8");
  const line = dotenv
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("SUPABASE_DEV_DATABASE_URL="));

  if (!line) {
    throw new Error("SUPABASE_DEV_DATABASE_URL is not configured.");
  }

  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/u, "$2");
}

function runSql(databaseUrl, sql) {
  const psql = process.env.PSQL_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `psql exited with code ${code}`));
    });
  });
}

async function restoreAndRemoveFixtures(databaseUrl) {
  const ids = testCycleIds.join(", ");
  const keys = configKeys.map(sqlText).join(", ");

  await runSql(
    databaseUrl,
    `
      delete from public.admin_action_logs
      where action = 'cycle_started'
        and target_type = 'cycle'
        and target_id in (${testCycleIds.map((id) => sqlText(id)).join(", ")});

      delete from public.voting_cycles where id in (${ids});

      do $cleanup$
      begin
        if to_regclass('public.${appConfigBackup}') is not null then
          delete from public.app_config where key in (${keys});
          execute 'insert into public.app_config (key, value) select key, value from public.${appConfigBackup}';
          execute 'drop table public.${appConfigBackup}';
        end if;

        if to_regclass('public.${userLogBackup}') is not null then
          execute 'update public.user_logs as target set upload_fail_count = backup.upload_fail_count from public.${userLogBackup} as backup where target.discord_user_id = backup.discord_user_id';
          execute 'drop table public.${userLogBackup}';
        end if;
      end;
      $cleanup$;
    `,
  );
}

async function prepareBackups(databaseUrl) {
  const keys = configKeys.map(sqlText).join(", ");

  await runSql(
    databaseUrl,
    `
      do $guard$
      begin
        if exists (
          select 1
          from public.voting_cycles
          where status in (
            'active', 'submission_open', 'submission_closed', 'voting_open',
            'voting_closed', 'paused', 'finalizing'
          )
        ) then
          raise exception 'DEV_CONCURRENCY_TEST_REQUIRES_NO_CURRENT_CYCLE';
        end if;
      end;
      $guard$;

      create table public.${appConfigBackup} as
      select key, value from public.app_config where key in (${keys});

      create table public.${userLogBackup} as
      select discord_user_id, upload_fail_count
      from public.user_logs
      where upload_fail_count <> 0;
    `,
  );
}

const startSettings = JSON.stringify({
  theme: "DEV concurrency test",
  themeSource: "manual",
  rewardDescription: "DEV concurrency reward",
  sponsored: { enabled: false },
});

function startSql(cycleId, actorId) {
  return `select public.start_cycle(${cycleId}, ${sqlText(actorId)}, ${sqlText(startSettings)}::jsonb);`;
}

async function testSameDraft(databaseUrl) {
  await runSql(
    databaseUrl,
    "insert into public.voting_cycles (id, status) values (2000010301, 'draft');",
  );

  const results = await Promise.allSettled([
    runSql(databaseUrl, startSql(2000010301, "900000000000000301")),
    runSql(databaseUrl, startSql(2000010301, "900000000000000302")),
  ]);

  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Concurrent same-draft start did not make both calls idempotently succeed.");
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if not exists (
          select 1 from public.voting_cycles
          where id = 2000010301 and status = 'submission_open'
        )
          or (select count(*) from public.cycle_events where cycle_id = 2000010301 and event_type = 'submission_phase_opened') <> 1
          or (select count(*) from public.admin_action_logs where target_id = '2000010301' and action = 'cycle_started') <> 1
        then
          raise exception 'CONCURRENT_SAME_DRAFT_ASSERTION_FAILED';
        end if;
      end;
      $assert$;

      delete from public.admin_action_logs where target_id = '2000010301' and action = 'cycle_started';
      delete from public.voting_cycles where id = 2000010301;
    `,
  );
}

async function testDifferentDrafts(databaseUrl) {
  await runSql(
    databaseUrl,
    "insert into public.voting_cycles (id, status) values (2000010302, 'draft'), (2000010303, 'draft');",
  );

  const results = await Promise.allSettled([
    runSql(databaseUrl, startSql(2000010302, "900000000000000303")),
    runSql(databaseUrl, startSql(2000010303, "900000000000000304")),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled").length;
  const rejected = results.filter((result) => result.status === "rejected").length;

  if (fulfilled !== 1 || rejected !== 1) {
    throw new Error("Concurrent different-draft start did not produce exactly one winner.");
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if (select count(*) from public.voting_cycles where id in (2000010302, 2000010303) and status = 'submission_open') <> 1
          or (select count(*) from public.voting_cycles where id in (2000010302, 2000010303) and status = 'draft') <> 1
          or (select count(*) from public.cycle_events where cycle_id in (2000010302, 2000010303) and event_type = 'submission_phase_opened') <> 1
          or (select count(*) from public.admin_action_logs where target_id in ('2000010302', '2000010303') and action = 'cycle_started') <> 1
        then
          raise exception 'CONCURRENT_DIFFERENT_DRAFT_ASSERTION_FAILED';
        end if;
      end;
      $assert$;

      delete from public.admin_action_logs where target_id in ('2000010302', '2000010303') and action = 'cycle_started';
      delete from public.voting_cycles where id in (2000010302, 2000010303);
    `,
  );
}

async function testAutomationBurst(databaseUrl) {
  await runSql(
    databaseUrl,
    `
      insert into public.voting_cycles (
        id, status, submission_starts_at, submission_ends_at
      ) values (
        2000010304,
        'submission_open',
        transaction_timestamp() - interval '1 hour',
        transaction_timestamp() - interval '1 minute'
      );

      insert into public.cycle_reminders (
        cycle_id, phase, reminder_type, due_at
      ) values (
        2000010304,
        'submission_open',
        'phase_end_due',
        transaction_timestamp() - interval '1 minute'
      );
    `,
  );

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      runSql(databaseUrl, "select public.process_due_cycle_transitions(2000010304);"),
    ),
  );

  if (results.some((result) => result.status === "rejected")) {
    throw new Error("At least one concurrent automation call failed.");
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if not exists (
          select 1 from public.voting_cycles
          where id = 2000010304
            and status = 'voting_open'
            and voting_starts_at is not null
            and voting_ends_at is null
        )
          or (select count(*) from public.cycle_events where cycle_id = 2000010304 and event_type = 'voting_phase_opened') <> 1
          or exists (select 1 from public.cycle_reminders where cycle_id = 2000010304 and status = 'pending')
        then
          raise exception 'CONCURRENT_AUTOMATION_ASSERTION_FAILED';
        end if;
      end;
      $assert$;

      delete from public.voting_cycles where id = 2000010304;
    `,
  );
}

const databaseUrl = await readDevDatabaseUrl();

if (!databaseUrl.includes(devProjectRef)) {
  throw new Error("Refusing to run: database URL is not the approved DEV project.");
}

await restoreAndRemoveFixtures(databaseUrl);

try {
  await prepareBackups(databaseUrl);
  await testSameDraft(databaseUrl);
  await testDifferentDrafts(databaseUrl);
  await testAutomationBurst(databaseUrl);
  console.log("DEV cycle concurrency tests passed.");
} finally {
  await restoreAndRemoveFixtures(databaseUrl);
}
