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
const runId = randomUUID();
const runSeed = BigInt(`0x${runId.replaceAll("-", "").slice(0, 12)}`);
const cycleId = Number(8_000_000_000n + (runSeed % 500_000_000n));
const userPrefix = `codex-upload-concurrency-${runId}-`;
const users = {
  same: `${userPrefix}same`,
  limit: `${userPrefix}limit`,
  independentA: `${userPrefix}independent-a`,
  independentB: `${userPrefix}independent-b`,
  close: `${userPrefix}close`,
  pause: `${userPrefix}pause`,
};
const sessions = {
  same: randomUUID(),
  limit: randomUUID(),
  independentA: randomUUID(),
  independentB: randomUUID(),
  close: randomUUID(),
  pause: randomUUID(),
};
const idempotencyKeys = {
  same: randomUUID(),
  limitSeed: randomUUID(),
  limitA: randomUUID(),
  limitB: randomUUID(),
  independentA: randomUUID(),
  independentB: randomUUID(),
  close: randomUUID(),
  pause: randomUUID(),
};

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readEnvFile(name) {
  let source;
  try {
    source = await readFile(path.join(repoRoot, name), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  const values = new Map();

  for (const line of source.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) {
      continue;
    }

    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    values.set(key, rawValue.replace(/^(['"])(.*)\1$/u, "$2"));
  }

  return values;
}

function getProjectRefFromDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const directMatch = parsed.hostname.match(/^db\.([^.]+)\./u);
  if (directMatch) {
    return directMatch[1];
  }

  const poolerMatch = decodeURIComponent(parsed.username).match(
    /^postgres\.([^:]+)$/u
  );
  return poolerMatch?.[1] ?? null;
}

async function loadSafeDevConfiguration() {
  const [localEnv, codexEnv] = await Promise.all([
    readEnvFile(".env.local"),
    readEnvFile(".env.codex.local"),
  ]);
  const databaseUrl =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    codexEnv.get("SUPABASE_DEV_DATABASE_URL");
  const websiteUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    localEnv.get("NEXT_PUBLIC_SUPABASE_URL");

  if (!databaseUrl || !websiteUrl) {
    throw new Error("Required DEV configuration is missing.");
  }

  const databaseRef = getProjectRefFromDatabaseUrl(databaseUrl);
  const websiteRef = new URL(websiteUrl).hostname.split(".")[0];
  if (!databaseRef || databaseRef !== websiteRef) {
    throw new Error("Refusing to run against a non-matching database project.");
  }

  return { databaseUrl };
}

function runSql(databaseUrl, sql) {
  const psql =
    process.env.PSQL_BIN ??
    "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      reject(new Error("The DEV database command could not start."));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error("A sanitized DEV database command failed."));
    });
  });
}

function rpcSql(name, argumentsSql) {
  return `select public.${name}(${argumentsSql})::text;`;
}

async function rpc(databaseUrl, name, argumentsSql) {
  return JSON.parse(await runSql(databaseUrl, rpcSql(name, argumentsSql)));
}

function reservationArgs({ session, key, fingerprint, content }) {
  return [
    `${sqlText(session)}::uuid`,
    `${sqlText(key)}::uuid`,
    sqlText(fingerprint),
    sqlText(content),
    sqlText("image/webp"),
    "100",
  ].join(", ");
}

async function markUploaded(databaseUrl, operationId, sessionId) {
  const result = await rpc(
    databaseUrl,
    "mark_submission_upload_r2_uploaded",
    `${sqlText(operationId)}::uuid, ${sqlText(sessionId)}::uuid, null`
  );
  if (result.outcome !== "r2_uploaded") {
    throw new Error("Synthetic R2 confirmation did not succeed.");
  }
}

async function commitKeep(databaseUrl, operationId, sessionId) {
  return rpc(
    databaseUrl,
    "commit_submission_upload",
    `${sqlText(operationId)}::uuid, ${sqlText(sessionId)}::uuid, 'wallet', 'keep', null, null`
  );
}

async function cleanupFixtures(databaseUrl) {
  await runSql(
    databaseUrl,
    `
      delete from public.upload_logs
      where discord_user_id like ${sqlText(`${userPrefix}%`)}
         or cycle_id = ${sqlText(cycleId)};

      delete from public.submission_upload_operations
      where cycle_id = ${cycleId}
         or discord_user_id like ${sqlText(`${userPrefix}%`)};

      delete from public.voting_cycles where id = ${cycleId};

      delete from public.media_cleanup_queue
      where storage_key like ${sqlText(`${cycleId}/%`)}
         or reason like 'submission_upload_compensation:%'
            and storage_key like ${sqlText(`${cycleId}/%`)}
         or reason like 'submission_deleted:%'
            and storage_key like ${sqlText(`${cycleId}/%`)};

      delete from public.sessions
      where discord_user_id like ${sqlText(`${userPrefix}%`)};
      delete from public.user_social_links
      where discord_user_id like ${sqlText(`${userPrefix}%`)};
      delete from public.discord_member_state
      where discord_user_id like ${sqlText(`${userPrefix}%`)};
      delete from public.user_logs
      where discord_user_id like ${sqlText(`${userPrefix}%`)};
    `
  );
}

async function setupFixtures(databaseUrl) {
  const userRows = Object.entries(users)
    .map(
      ([name, user]) =>
        `(${sqlText(user)}, ${sqlText(`codex-${name}`)})`
    )
    .join(",\n");
  const memberRows = Object.entries(users)
    .map(
      ([name, user]) =>
        `(${sqlText(user)}, ${sqlText(`codex-${name}`)}, transaction_timestamp() - interval '1 day', true)`
    )
    .join(",\n");
  const sessionRows = Object.entries(users)
    .map(
      ([name, user]) =>
        `(${sqlText(sessions[name])}::uuid, ${sqlText(user)})`
    )
    .join(",\n");

  await runSql(
    databaseUrl,
    `
      do $guard$
      begin
        if exists (
          select 1 from public.voting_cycles
          where status in (
            'active', 'submission_open', 'submission_closed', 'voting_open',
            'voting_closed', 'paused', 'finalizing'
          )
        ) then
          raise exception 'DEV_UPLOAD_CONCURRENCY_REQUIRES_NO_CURRENT_CYCLE';
        end if;
      end;
      $guard$;

      insert into public.voting_cycles (
        id, status, starts_at, submission_starts_at,
        submissions_per_user, upload_success_cooldown_seconds
      ) values (
        ${cycleId},
        'submission_open',
        transaction_timestamp() - interval '1 hour',
        transaction_timestamp() - interval '1 hour',
        2,
        30
      );

      with rules as (
        select current_version from public.rules_meta where id = 1
      )
      insert into public.user_logs (
        discord_user_id, current_discord_username, accepted_rules_version
      )
      select
        fixture.discord_user_id,
        fixture.current_discord_username,
        rules.current_version
      from rules
      cross join (values ${userRows}) fixture(
        discord_user_id, current_discord_username
      );

      insert into public.discord_member_state (
        discord_user_id, current_discord_username, discord_joined_at, is_in_discord
      ) values ${memberRows};

      insert into public.sessions (id, discord_user_id)
      values ${sessionRows};
    `
  );
}

async function testSameIdempotencyKey(databaseUrl) {
  const args = reservationArgs({
    session: sessions.same,
    key: idempotencyKeys.same,
    fingerprint: "a".repeat(64),
    content: "b".repeat(64),
  });
  const results = await Promise.all([
    rpc(databaseUrl, "reserve_submission_upload", args),
    rpc(databaseUrl, "reserve_submission_upload", args),
  ]);
  const outcomes = results.map((result) => result.outcome).sort();

  if (outcomes.join(",") !== "in_progress,reserved") {
    throw new Error("Concurrent equal requests were not deduplicated.");
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if (
          select count(*) from public.submission_upload_operations
          where discord_user_id = ${sqlText(users.same)}
        ) <> 1 then
          raise exception 'SAME_IDEMPOTENCY_CREATED_MULTIPLE_OPERATIONS';
        end if;
      end;
      $assert$;
    `
  );
}

async function testOneRemainingSlot(databaseUrl) {
  const seedReservation = await rpc(
    databaseUrl,
    "reserve_submission_upload",
    reservationArgs({
      session: sessions.limit,
      key: idempotencyKeys.limitSeed,
      fingerprint: "7".repeat(64),
      content: "8".repeat(64),
    })
  );
  if (seedReservation.outcome !== "reserved") {
    throw new Error("The quota seed could not be reserved.");
  }
  await markUploaded(
    databaseUrl,
    seedReservation.operationId,
    sessions.limit
  );
  const seedCommit = await commitKeep(
    databaseUrl,
    seedReservation.operationId,
    sessions.limit
  );
  if (seedCommit.outcome !== "completed") {
    throw new Error("The quota seed could not be committed.");
  }
  await runSql(
    databaseUrl,
    `update public.submission_upload_operations
     set completed_at = clock_timestamp() - interval '31 seconds'
     where id = ${sqlText(seedReservation.operationId)}::uuid;`
  );

  const definitions = [
    {
      session: sessions.limit,
      key: idempotencyKeys.limitA,
      fingerprint: "1".repeat(64),
      content: "3".repeat(64),
    },
    {
      session: sessions.limit,
      key: idempotencyKeys.limitB,
      fingerprint: "2".repeat(64),
      content: "4".repeat(64),
    },
  ];
  const attempts = definitions.map((definition) =>
    rpc(
      databaseUrl,
      "reserve_submission_upload",
      reservationArgs(definition)
    )
  );
  const results = await Promise.all(attempts);
  const reservedIndex = results.findIndex(
    (result) => result.outcome === "reserved"
  );
  const blockedIndex = results.findIndex(
    (result) => result.outcome === "upload_in_progress"
  );
  const reserved = results.filter((result) => result.outcome === "reserved");
  const blocked = results.filter(
    (result) => result.outcome === "upload_in_progress"
  );

  if (reserved.length !== 1 || blocked.length !== 1) {
    throw new Error("Concurrent different requests bypassed the active slot.");
  }

  await markUploaded(
    databaseUrl,
    reserved[0].operationId,
    sessions.limit
  );
  const committed = await commitKeep(
    databaseUrl,
    reserved[0].operationId,
    sessions.limit
  );
  if (committed.outcome !== "completed") {
    throw new Error("The winning upload did not commit.");
  }

  const retry = await rpc(
    databaseUrl,
    "reserve_submission_upload",
    reservationArgs(definitions[reservedIndex])
  );

  if (
    retry.outcome !== "already_completed" ||
    retry.submissionId !== committed.submissionId
  ) {
    throw new Error("A committed retry was not a stable success.");
  }

  const blockedRetry = await rpc(
    databaseUrl,
    "reserve_submission_upload",
    reservationArgs(definitions[blockedIndex])
  );
  if (
    blockedRetry.outcome !== "upload_limit_reached" ||
    blockedRetry.used !== 2 ||
    blockedRetry.limit !== 2 ||
    blockedRetry.remaining !== 0
  ) {
    throw new Error("The losing final-slot retry did not observe exhausted quota.");
  }

  const quota = await rpc(
    databaseUrl,
    "get_submission_upload_quota",
    `${cycleId}, ${sqlText(users.limit)}`
  );
  if (
    quota.outcome !== "status" ||
    quota.used !== 2 ||
    quota.limit !== 2 ||
    quota.remaining !== 0 ||
    quota.cooldownRemainingSeconds !== 0 ||
    quota.nextUploadAllowedAt !== null
  ) {
    throw new Error("The final-slot quota projection was not stable.");
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if (
          select count(*) from public.submissions
          where cycle_id = ${cycleId}
            and discord_user_id = ${sqlText(users.limit)}
        ) <> 2 then
          raise exception 'CONCURRENT_UPLOAD_LIMIT_ASSERTION_FAILED';
        end if;

        if (
          select count(*) from public.submission_upload_operations
          where cycle_id = ${cycleId}
            and discord_user_id = ${sqlText(users.limit)}
        ) <> 2 then
          raise exception 'CONCURRENT_UPLOAD_OPERATION_ASSERTION_FAILED';
        end if;

        if exists (
          select 1 from public.submission_upload_operations
          where cycle_id = ${cycleId}
            and discord_user_id = ${sqlText(users.limit)}
            and status <> 'completed'
        ) then
          raise exception 'CONCURRENT_UPLOAD_LEFT_ACTIVE_OPERATION';
        end if;
      end;
      $assert$;
    `
  );
}

async function testIndependentUsers(databaseUrl) {
  const definitions = [
    {
      session: sessions.independentA,
      key: idempotencyKeys.independentA,
      fingerprint: "c".repeat(64),
      content: "d".repeat(64),
    },
    {
      session: sessions.independentB,
      key: idempotencyKeys.independentB,
      fingerprint: "e".repeat(64),
      content: "f".repeat(64),
    },
  ];
  const reservations = await Promise.all(
    definitions.map((definition) =>
      rpc(
        databaseUrl,
        "reserve_submission_upload",
        reservationArgs(definition)
      )
    )
  );
  if (reservations.some((result) => result.outcome !== "reserved")) {
    throw new Error("Independent users could not reserve independently.");
  }

  await Promise.all(
    reservations.map((reservation, index) =>
      markUploaded(
        databaseUrl,
        reservation.operationId,
        definitions[index].session
      )
    )
  );
  const commits = await Promise.all(
    reservations.map((reservation, index) =>
      commitKeep(
        databaseUrl,
        reservation.operationId,
        definitions[index].session
      )
    )
  );
  if (commits.some((result) => result.outcome !== "completed")) {
    throw new Error("Independent users did not both commit.");
  }
}

async function waitForTransactionBarrier(databaseUrl, advisoryKey) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runSql(
      databaseUrl,
      `select case when pg_try_advisory_lock(${advisoryKey}) then pg_advisory_unlock(${advisoryKey})::text else 'busy' end;`
    );
    if (result === "busy") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("The phase-race transaction barrier was not reached.");
}

async function testPhaseRace(databaseUrl, mode) {
  const session = sessions[mode];
  const user = users[mode];
  const reservation = await rpc(
    databaseUrl,
    "reserve_submission_upload",
    reservationArgs({
      session,
      key: idempotencyKeys[mode],
      fingerprint: (mode === "close" ? "1" : "2").repeat(64),
      content: (mode === "close" ? "3" : "4").repeat(64),
    })
  );
  await markUploaded(databaseUrl, reservation.operationId, session);

  const phaseSql =
    mode === "close"
      ? `update public.voting_cycles set status = 'submission_closed' where id = ${cycleId};`
      : `update public.voting_cycles set status = 'paused', paused_from_status = 'submission_open' where id = ${cycleId};`;
  const advisoryKey = mode === "close" ? cycleId * 10 + 1 : cycleId * 10 + 2;
  const phaseChange = runSql(
    databaseUrl,
    `begin; select pg_advisory_xact_lock(${advisoryKey}); ${phaseSql} select pg_sleep(2); commit;`
  );
  await waitForTransactionBarrier(databaseUrl, advisoryKey);
  const commit = await commitKeep(
    databaseUrl,
    reservation.operationId,
    session
  );
  await phaseChange;

  if (commit.outcome !== "cycle_not_open") {
    throw new Error(`The ${mode} race allowed a late upload commit.`);
  }

  await runSql(
    databaseUrl,
    `
      do $assert$
      begin
        if exists (
          select 1 from public.submissions
          where cycle_id = ${cycleId}
            and discord_user_id = ${sqlText(user)}
        ) then
          raise exception 'PHASE_RACE_LEFT_VISIBLE_SUBMISSION';
        end if;
      end;
      $assert$;
      update public.voting_cycles
      set status = 'submission_open', paused_from_status = null
      where id = ${cycleId};
    `
  );
}

const { databaseUrl } = await loadSafeDevConfiguration();
await cleanupFixtures(databaseUrl);
const queueBaseline = await runSql(
  databaseUrl,
  "select count(*)::text || ':' || coalesce(md5(string_agg(id::text || ':' || status, ',' order by id)), 'empty') from public.media_cleanup_queue;"
);

try {
  await setupFixtures(databaseUrl);
  await testSameIdempotencyKey(databaseUrl);
  await testOneRemainingSlot(databaseUrl);
  await testIndependentUsers(databaseUrl);
  await testPhaseRace(databaseUrl, "close");
  await testPhaseRace(databaseUrl, "pause");
  console.log("DEV submission upload concurrency tests passed.");
} finally {
  await cleanupFixtures(databaseUrl);
}

const queueAfter = await runSql(
  databaseUrl,
  "select count(*)::text || ':' || coalesce(md5(string_agg(id::text || ':' || status, ',' order by id)), 'empty') from public.media_cleanup_queue;"
);
if (queueAfter !== queueBaseline) {
  throw new Error("Historical media cleanup queue state changed during testing.");
}

console.log("DEV submission upload concurrency cleanup passed.");
