import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const psql =
  process.env.PSQL_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const userId = "codex-upload-abuse-concurrency";
const sessionId = "93000001-0000-4000-8000-000000000001";
const sagaUserA = `${userId}-saga-a`;
const sagaUserB = `${userId}-saga-b`;
const sagaSessionA = "93000001-0000-4000-8000-000000000002";
const sagaSessionB = "93000001-0000-4000-8000-000000000003";
const syntheticCycleId = 9300000101;

async function readEnv(name) {
  const values = new Map();
  let source;
  try {
    source = await readFile(path.join(repoRoot, name), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return values;
    throw error;
  }
  for (const line of source.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values.set(
      line.slice(0, index).trim(),
      line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/u, "$2")
    );
  }
  return values;
}

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const direct = parsed.hostname.match(/^db\.([^.]+)\./u);
  if (direct) return direct[1];
  return decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ?? null;
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([readEnv(".env.local"), readEnv(".env.codex.local")]);
  const databaseUrl = process.env.SUPABASE_DEV_DATABASE_URL ?? codex.get("SUPABASE_DEV_DATABASE_URL");
  const websiteUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? local.get("NEXT_PUBLIC_SUPABASE_URL");
  if (!databaseUrl || !websiteUrl) throw new Error("Required DEV configuration is missing.");
  if (projectRef(databaseUrl) !== new URL(websiteUrl).hostname.split(".")[0]) {
    throw new Error("Refusing to run against a non-matching database project.");
  }
  return databaseUrl;
}

function runPsql(databaseUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
      cwd: repoRoot,
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("The DEV database command could not start.")));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error("A sanitized DEV database command failed."))
    );
  });
}

const sql = (databaseUrl, source) =>
  runPsql(databaseUrl, ["-At", "-c", source]);
const rpc = async (databaseUrl, source) => JSON.parse(await sql(databaseUrl, source));

async function cleanup(databaseUrl) {
  await sql(
    databaseUrl,
    `
      delete from public.submission_upload_operations where discord_user_id like '${userId}%';
      delete from public.submission_upload_abuse_states where discord_user_id like '${userId}%';
      delete from public.sessions where discord_user_id like '${userId}%';
      delete from public.discord_member_state where discord_user_id like '${userId}%';
      delete from public.user_logs where discord_user_id like '${userId}%';
    `
  );
}

const databaseUrl = await loadDevDatabaseUrl();
await runPsql(databaseUrl, ["-f", "tests/db/submissionUploadAbuse.dev.sql"]);
const currentCycleId = await sql(
  databaseUrl,
  "select id from public.voting_cycles where status::text in ('submission_open','active') order by id desc limit 1;"
);
let cycleId = currentCycleId ? Number(currentCycleId) : Number.NaN;
let createdSyntheticCycle = false;
if (!Number.isSafeInteger(cycleId)) {
  const collision = await sql(
    databaseUrl,
    `select exists(select 1 from public.voting_cycles where id = ${syntheticCycleId})::text;`
  );
  if (collision === "true") {
    throw new Error("The synthetic DEV Cycle ID is already in use.");
  }

  cycleId = syntheticCycleId;
  await sql(
    databaseUrl,
    `
      insert into public.voting_cycles (
        id,
        status,
        starts_at,
        submission_starts_at,
        votes_per_user,
        allow_self_vote
      ) values (
        ${cycleId},
        'submission_open',
        transaction_timestamp(),
        transaction_timestamp(),
        2,
        false
      );
    `
  );
  createdSyntheticCycle = true;
}

await cleanup(databaseUrl);
const baseline = await sql(
  databaseUrl,
  "select count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(s)::text, ',' order by discord_user_id, cycle_id)), 'empty') from public.submission_upload_abuse_states s;"
);

try {
  await sql(
    databaseUrl,
    `
      insert into public.user_logs (discord_user_id, current_discord_username, accepted_rules_version)
      select fixture.discord_user_id, fixture.username, rules.current_version
      from public.rules_meta rules
      cross join (values
        ('${userId}', 'codex-abuse-concurrency'),
        ('${sagaUserA}', 'codex-abuse-saga-a'),
        ('${sagaUserB}', 'codex-abuse-saga-b')
      ) fixture(discord_user_id, username)
      where rules.id = 1;
      insert into public.discord_member_state (
        discord_user_id, current_discord_username, discord_joined_at, is_in_discord
      ) values
        ('${userId}', 'codex-abuse-concurrency', transaction_timestamp() - interval '1 day', true),
        ('${sagaUserA}', 'codex-abuse-saga-a', transaction_timestamp() - interval '1 day', true),
        ('${sagaUserB}', 'codex-abuse-saga-b', transaction_timestamp() - interval '1 day', true);
      insert into public.sessions (id, discord_user_id)
      values
        ('${sessionId}'::uuid, '${userId}'),
        ('${sagaSessionA}'::uuid, '${sagaUserA}'),
        ('${sagaSessionB}'::uuid, '${sagaUserB}');
    `
  );

  const reserveSql = (session, key, fingerprint, content) =>
    `select public.reserve_submission_upload('${session}'::uuid, '${key}'::uuid, repeat('${fingerprint}',64), repeat('${content}',64), 'image/webp', 100)::text;`;

  const sameKey = await Promise.all([
    rpc(databaseUrl, reserveSql(sagaSessionA, "93000001-0000-4000-8000-000000000101", "a", "b")),
    rpc(databaseUrl, reserveSql(sagaSessionA, "93000001-0000-4000-8000-000000000101", "a", "b")),
  ]);
  const sameKeyOutcomes = sameKey
    .map((result) => result.outcome)
    .sort()
    .join(",");
  if (sameKeyOutcomes !== "in_progress,reserved") {
    throw new Error(
      `Concurrent identical upload keys were not deduplicated: ${sameKeyOutcomes}`
    );
  }
  await sql(databaseUrl, `delete from public.submission_upload_operations where discord_user_id = '${sagaUserA}';`);

  const differentKeys = await Promise.all([
    rpc(databaseUrl, reserveSql(sagaSessionA, "93000001-0000-4000-8000-000000000102", "c", "d")),
    rpc(databaseUrl, reserveSql(sagaSessionA, "93000001-0000-4000-8000-000000000103", "e", "f")),
  ]);
  if (differentKeys.map((result) => result.outcome).sort().join(",") !== "reserved,upload_in_progress") {
    throw new Error("Concurrent different upload keys bypassed the active slot.");
  }
  await sql(databaseUrl, `delete from public.submission_upload_operations where discord_user_id = '${sagaUserA}';`);

  const independent = await Promise.all([
    rpc(databaseUrl, reserveSql(sagaSessionA, "93000001-0000-4000-8000-000000000104", "1", "2")),
    rpc(databaseUrl, reserveSql(sagaSessionB, "93000001-0000-4000-8000-000000000105", "3", "4")),
  ]);
  if (independent.some((result) => result.outcome !== "reserved")) {
    throw new Error("Independent users interfered during upload reservation.");
  }
  await sql(databaseUrl, `delete from public.submission_upload_operations where discord_user_id in ('${sagaUserA}', '${sagaUserB}');`);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await rpc(
      databaseUrl,
      `select public.register_invalid_submission_upload('${sessionId}'::uuid, ${cycleId}, 'MEDIA_CORRUPT')::text;`
    );
    if (result.outcome !== "counted" || result.invalidAttemptCount !== attempt) {
      throw new Error("The setup attempts were not counted atomically.");
    }
  }

  const results = await Promise.all(
    ["MEDIA_CORRUPT", "MEDIA_PIXEL_LIMIT_EXCEEDED"].map((code) =>
      rpc(
        databaseUrl,
        `select public.register_invalid_submission_upload('${sessionId}'::uuid, ${cycleId}, '${code}')::text;`
      )
    )
  );
  const outcomes = results.map((result) => result.outcome).sort().join(",");
  if (outcomes !== "already_blocked,blocked") {
    throw new Error("Concurrent fifth attempts bypassed the block boundary.");
  }

  const state = await sql(
    databaseUrl,
    `select invalid_attempt_count::text || ':' || total_invalid_attempt_count::text || ':' || block_count::text || ':' || (blocked_at is not null)::text from public.submission_upload_abuse_states where discord_user_id = '${userId}' and cycle_id = ${cycleId};`
  );
  if (state !== "5:5:1:true") {
    throw new Error("Concurrent attempts produced an inconsistent block state.");
  }

  let reservationRejected = false;
  try {
    await sql(
      databaseUrl,
      `select public.reserve_submission_upload('${sessionId}'::uuid, '93000001-0000-4000-8000-000000000011'::uuid, repeat('a',64), repeat('b',64), 'image/webp', 100);`
    );
  } catch {
    reservationRejected = true;
  }
  if (!reservationRejected) throw new Error("A blocked user reached upload reservation.");
  const operationCount = await sql(
    databaseUrl,
    `select count(*) from public.submission_upload_operations where discord_user_id = '${userId}';`
  );
  if (operationCount !== "0") throw new Error("A blocked request created an upload intent.");

  console.log("DEV submission upload abuse rollback and concurrency tests passed.");
} finally {
  await cleanup(databaseUrl);
  if (createdSyntheticCycle) {
    await sql(
      databaseUrl,
      `delete from public.voting_cycles where id = ${cycleId};`
    );
  }
}

const after = await sql(
  databaseUrl,
  "select count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(s)::text, ',' order by discord_user_id, cycle_id)), 'empty') from public.submission_upload_abuse_states s;"
);
if (after !== baseline) throw new Error("Historical upload abuse state changed during testing.");
console.log("DEV submission upload abuse cleanup passed.");
