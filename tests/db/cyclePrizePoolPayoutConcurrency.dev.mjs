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
const quote = (value) =>
  `'${String(value).replaceAll("'", "''")}'`;

async function databaseUrl() {
  const env = await readFile(
    path.join(repoRoot, ".env.codex.local"),
    "utf8"
  );
  const line = env
    .split(/\r?\n/u)
    .find((entry) =>
      /^\s*SUPABASE_DEV_DATABASE_URL\s*=/u.test(entry)
    );
  const value =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/u, "$2");
  const parsed = value ? new URL(value) : null;
  const ref = parsed
    ? (parsed.username.match(/^postgres\.([^:]+)$/u)?.[1] ??
      parsed.hostname.match(/^db\.([^.]+)\./u)?.[1])
    : null;
  if (!value || ref !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run payout concurrency outside DEV.");
  }
  return value;
}

function runSql(url, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () =>
      reject(new Error("The DEV database command could not start."))
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              stderr
                .replaceAll(url, "[DEV_DATABASE_URL]")
                .replace(/\s+/gu, " ")
                .trim()
                .slice(0, 400)
            )
          )
    );
  });
}

const url = await databaseUrl();
const fixture = await runSql(
  url,
  "select (select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1)||'|'||(select id::text from public.voting_cycles order by id desc limit 1)||'|'||coalesce((select row_version::text from public.cycle_prize_pools where cycle_id=(select max(id) from public.voting_cycles)),'0')||'|'||coalesce((select announced_lamports::text from public.cycle_prize_pools where cycle_id=(select max(id) from public.voting_cycles)),'null');"
);
const [adminId, cycleId, version, amountBefore] = fixture.split("|");
if (
  !/^\d+$/u.test(adminId) ||
  !/^\d+$/u.test(cycleId) ||
  !/^\d+$/u.test(version)
) {
  throw new Error("DEV immutable Cycle fixture is unavailable.");
}

const attempts = await Promise.allSettled(
  [700000001, 700000002].map((amount) =>
    runSql(
      url,
      `select public.manage_current_cycle_prize_pool(${quote(adminId)},${quote(randomUUID())}::uuid,${cycleId},${version},${amount},${amount})::text;`
    )
  )
);
if (
  attempts.some(
    (attempt) =>
      attempt.status !== "rejected" ||
      !attempt.reason.message.includes(
        "CYCLE_PRIZE_POOL_DEADLINE_PASSED"
      )
  )
) {
  throw new Error("A concurrent retroactive pool write was not rejected.");
}

const snapshotAfter = await runSql(
  url,
  `select row_version::text||'|'||coalesce(announced_lamports::text,'null') from public.cycle_prize_pools where cycle_id=${cycleId};`
);
if (snapshotAfter !== `${version}|${amountBefore}`) {
  throw new Error("Rejected retroactive writes changed the pool snapshot.");
}

const structural = await runSql(
  url,
  `select
    (pg_get_functiondef('public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint)'::regprocedure) ~ 'for update')::text||'|'||
    (pg_get_functiondef('public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint)'::regprocedure) ~ 'cycle-phase-automation-global')::text||'|'||
    (select count(*)=1 from pg_trigger where tgrelid='public.cycle_prize_pools'::regclass and tgname='cycle_prize_pool_lifecycle_guard' and not tgisinternal)::text;`
);
if (structural !== "true|true|true") {
  throw new Error(`Prize-pool concurrency structure drifted: ${structural}`);
}

console.log(
  JSON.stringify({
    result: "retroactive_pool_concurrency_rejected",
    rejectedAttempts: 2,
    snapshotUnchanged: true,
    rowAndPhaseLocksPresent: true,
  })
);
