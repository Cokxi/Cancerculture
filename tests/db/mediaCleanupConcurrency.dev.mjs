import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const devProjectRef = "gceljiuydyiwkomymuqh";
const fixtureReason = "codex_media_cleanup_concurrency_test";
const backupTable = "_codex_media_cleanup_old_leases";

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
      { cwd: repoRoot, windowsHide: true }
    );
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `psql exited with code ${code}`));
    });
  });
}

async function cleanup(databaseUrl) {
  await runSql(
    databaseUrl,
    `
      drop table if exists public.${backupTable};
      delete from public.media_cleanup_queue
      where reason = '${fixtureReason}';
    `
  );
}

const claimFour = `
  do $claim$
  declare
    v_count integer;
  begin
    select count(*)::integer
    into v_count
    from public.claim_media_cleanup_jobs(4, 120);

    if v_count <> 4 then
      raise exception 'EXPECTED_FOUR_CLAIMS_GOT_%', v_count;
    end if;
  end;
  $claim$;
`;

const claimNone = `
  do $claim$
  declare
    v_count integer;
  begin
    select count(*)::integer
    into v_count
    from public.claim_media_cleanup_jobs(4, 120);

    if v_count <> 0 then
      raise exception 'ACTIVE_LEASES_WERE_RECLAIMED_%', v_count;
    end if;
  end;
  $claim$;
`;

const databaseUrl = await readDevDatabaseUrl();

if (!databaseUrl.includes(devProjectRef)) {
  throw new Error("Refusing to run: database URL is not the approved DEV project.");
}

await cleanup(databaseUrl);

try {
  await runSql(
    databaseUrl,
    `
      insert into public.media_cleanup_queue (
        id, storage_provider, storage_key, reason, status
      ) overriding system value
      select
        2100001000 + series,
        'r2',
        'codex-tests/media-cleanup/concurrency-' || series::text || '.webp',
        '${fixtureReason}',
        'pending'
      from generate_series(1, 8) series;
    `
  );

  await Promise.all([
    runSql(databaseUrl, claimFour),
    runSql(databaseUrl, claimFour),
  ]);

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if (select count(*) from public.media_cleanup_queue where reason = '${fixtureReason}' and status = 'processing') <> 8
          or (select count(distinct lease_token) from public.media_cleanup_queue where reason = '${fixtureReason}') <> 8
          or exists (select 1 from public.media_cleanup_queue where reason = '${fixtureReason}' and attempts <> 1)
        then
          raise exception 'PARALLEL_CLAIM_DISTRIBUTION_FAILED';
        end if;
      end;
      $assert$;

      create table public.${backupTable} as
      select id, lease_token
      from public.media_cleanup_queue
      where reason = '${fixtureReason}';
    `
  );

  await Promise.all([
    runSql(databaseUrl, claimNone),
    runSql(databaseUrl, claimNone),
  ]);

  await runSql(
    databaseUrl,
    `
      update public.media_cleanup_queue
      set
        locked_at = transaction_timestamp() - interval '2 minutes',
        locked_until = transaction_timestamp() - interval '1 minute'
      where reason = '${fixtureReason}';
    `
  );

  await Promise.all([
    runSql(databaseUrl, claimFour),
    runSql(databaseUrl, claimFour),
  ]);

  await runSql(
    databaseUrl,
    `
      do $assert$
      declare
        v_row record;
        v_result jsonb;
      begin
        if (select count(*) from public.media_cleanup_queue where reason = '${fixtureReason}' and status = 'processing') <> 8
          or (select count(distinct lease_token) from public.media_cleanup_queue where reason = '${fixtureReason}') <> 8
          or exists (select 1 from public.media_cleanup_queue where reason = '${fixtureReason}' and attempts <> 2)
          or exists (
            select 1
            from public.media_cleanup_queue current_job
            join public.${backupTable} old_job using (id)
            where current_job.lease_token = old_job.lease_token
          )
        then
          raise exception 'EXPIRED_LEASE_PARALLEL_RECLAIM_FAILED';
        end if;

        for v_row in
          select current_job.id, old_job.lease_token
          from public.media_cleanup_queue current_job
          join public.${backupTable} old_job using (id)
          where current_job.reason = '${fixtureReason}'
        loop
          v_result := public.complete_media_cleanup_job(
            v_row.id,
            v_row.lease_token
          );

          if v_result ->> 'outcome' <> 'stale_lease' then
            raise exception 'OLD_PARALLEL_WORKER_RESULT_ACCEPTED';
          end if;
        end loop;
      end;
      $assert$;
    `
  );

  console.log("DEV media cleanup concurrency tests passed.");
} finally {
  await cleanup(databaseUrl);
}
