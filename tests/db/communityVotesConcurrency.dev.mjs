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
const numericSuffix = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`)
  .toString()
  .slice(0, 14);
const voterId = `96${numericSuffix.padStart(16, "0")}`;
const sessionA = randomUUID();
const sessionB = randomUUID();
let pollPublicId;
let pollVersion;
let adminId;

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readEnv(name) {
  const source = await readFile(path.join(repoRoot, name), "utf8");
  const values = new Map();
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
  return (
    parsed.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ??
    null
  );
}

async function loadDevDatabaseUrl() {
  const values = await readEnv(".env.codex.local");
  const databaseUrl =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    values.get("SUPABASE_DEV_DATABASE_URL");
  if (!databaseUrl || projectRef(databaseUrl) !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run Community Votes concurrency outside DEV.");
  }
  return databaseUrl;
}

function runSql(databaseUrl, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", source],
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
    child.on("error", () => {
      reject(new Error("The DEV database command could not start."));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = stderr
        .replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500);
      reject(
        new Error(`Sanitized Community Votes DEV SQL failed${detail ? `: ${detail}` : "."}`)
      );
    });
  });
}

async function rpc(databaseUrl, expression) {
  return JSON.parse(await runSql(databaseUrl, `select ${expression}::text;`));
}

async function cleanup(databaseUrl) {
  if (pollPublicId && adminId && pollVersion) {
    try {
      const current = await runSql(
        databaseUrl,
        `select status || '|' || row_version::text from public.community_polls where public_id=${quote(pollPublicId)}::uuid;`
      );
      const [status, version] = current.split("|");
      if (status === "active") {
        await rpc(
          databaseUrl,
          `public.abort_community_poll(${quote(adminId)},${quote(pollPublicId)}::uuid,${quote(randomUUID())}::uuid,${Number(version)},'Completed parallel double-vote DEV verification')`
        );
      }
    } catch {
      // Preserve the original verification failure; postflight will expose cleanup drift.
    }
  }
  await runSql(
    databaseUrl,
    `delete from public.sessions where discord_user_id=${quote(voterId)}; delete from public.user_logs where discord_user_id=${quote(voterId)};`
  );
}

const databaseUrl = await loadDevDatabaseUrl();

try {
  adminId = await runSql(
    databaseUrl,
    "select discord_user_id from public.team_members where role='admin' order by discord_user_id limit 1;"
  );
  if (!/^\d+$/u.test(adminId)) {
    throw new Error("DEV Admin fixture is unavailable.");
  }

  await runSql(
    databaseUrl,
    `
      insert into public.user_logs (discord_user_id,current_discord_username,is_banned)
      values (${quote(voterId)},'community-votes-concurrency',false);
      insert into public.sessions (id,discord_user_id) values
        (${quote(sessionA)}::uuid,${quote(voterId)}),
        (${quote(sessionB)}::uuid,${quote(voterId)});
    `
  );

  const created = await rpc(
    databaseUrl,
    `public.create_community_poll(${quote(adminId)},${quote(randomUUID())}::uuid,'[DEV TEST] Can parallel requests record only one vote?','Auditable DEV concurrency artifact; no Cycle or payout behavior.',24,'["Parallel Alpha","Parallel Beta"]'::jsonb)`
  );
  if (created.outcome !== "created") {
    throw new Error("Concurrency poll creation failed.");
  }
  pollPublicId = created.pollPublicId;
  const activated = await rpc(
    databaseUrl,
    `public.activate_community_poll(${quote(adminId)},${quote(pollPublicId)}::uuid,${quote(randomUUID())}::uuid,${created.rowVersion})`
  );
  if (activated.outcome !== "activated") {
    throw new Error("Concurrency poll activation failed.");
  }
  pollVersion = activated.rowVersion;

  const optionRows = await runSql(
    databaseUrl,
    `select option.public_id from public.community_poll_options option join public.community_polls poll on poll.id=option.poll_id where poll.public_id=${quote(pollPublicId)}::uuid order by option.display_order;`
  );
  const options = optionRows.split(/\r?\n/u).filter(Boolean);
  if (options.length !== 2) {
    throw new Error("Concurrency options are unavailable.");
  }

  const calls = [
    `public.cast_community_poll_vote(${quote(sessionA)}::uuid,${quote(pollPublicId)}::uuid,${quote(options[0])}::uuid,${quote(randomUUID())}::uuid,${pollVersion})`,
    `public.cast_community_poll_vote(${quote(sessionB)}::uuid,${quote(pollPublicId)}::uuid,${quote(options[1])}::uuid,${quote(randomUUID())}::uuid,${pollVersion})`,
  ];
  const results = await Promise.all(calls.map((call) => rpc(databaseUrl, call)));
  const outcomes = results.map((result) => result.outcome).sort();
  if (outcomes.join("|") !== "already_participated|voted") {
    throw new Error(`Parallel double vote was not serialized: ${outcomes.join("|")}`);
  }

  const invariant = await runSql(
    databaseUrl,
    `
      select
        (select count(*) from public.community_poll_participants participant join public.community_polls poll on poll.id=participant.poll_id where poll.public_id=${quote(pollPublicId)}::uuid)::text
        || '|' ||
        (select sum(option.vote_count) from public.community_poll_options option join public.community_polls poll on poll.id=option.poll_id where poll.public_id=${quote(pollPublicId)}::uuid)::text
        || '|' ||
        (select count(*) from public.community_poll_options option join public.community_polls poll on poll.id=option.poll_id where poll.public_id=${quote(pollPublicId)}::uuid and option.vote_count=1)::text;
    `
  );
  if (invariant !== "1|1|1") {
    throw new Error(`Parallel vote invariants failed: ${invariant}`);
  }

  console.log(
    JSON.stringify({
      result: "community_votes_concurrency_ok",
      outcomes,
      participantFacts: 1,
      aggregateVotes: 1,
    })
  );
} finally {
  await cleanup(databaseUrl);
}
