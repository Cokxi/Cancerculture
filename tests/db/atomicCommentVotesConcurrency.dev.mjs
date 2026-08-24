import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    throw new Error("Refusing to run Comment Vote concurrency outside DEV.");
  }
  return value;
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
    child.on("error", () => reject(new Error("The DEV Vote concurrency command could not start.")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr.replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ").trim().slice(0, 500);
      reject(new Error(`Sanitized Comment Vote concurrency SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

function lockSql(lockKey) {
  return `
    begin;
    select pg_advisory_xact_lock(hashtextextended('${lockKey.replaceAll("'", "''")}', 0));
    select pg_sleep(0.5);
    select 'locked';
    rollback;
  `;
}

async function timed(databaseUrl, statements) {
  const startedAt = performance.now();
  const results = await Promise.all(statements.map((sql) => runSql(databaseUrl, sql)));
  if (results.some((result) => !result.endsWith("locked"))) {
    throw new Error("Comment Vote lock transaction did not complete.");
  }
  return performance.now() - startedAt;
}

const databaseUrl = await loadDevDatabaseUrl();
const commentId = randomUUID();
const sameVoter = `vote-concurrency-${randomUUID()}`;
const samePairKey = `community-comment-vote:${sameVoter}:${commentId}`;
const samePairMs = await timed(databaseUrl, [lockSql(samePairKey), lockSql(samePairKey)]);
if (samePairMs < 850 || samePairMs > 8_000) {
  throw new Error("Same voter/Comment mutations did not serialize.");
}

const independentMs = await timed(databaseUrl, [
  lockSql(`community-comment-vote:${randomUUID()}:${commentId}`),
  lockSql(`community-comment-vote:${randomUUID()}:${commentId}`),
]);
if (
  independentMs < 350 ||
  independentMs > 3_000 ||
  independentMs >= samePairMs - 250
) {
  throw new Error("Different voters were unexpectedly serialized by one global Comment lock.");
}

const state = await runSql(databaseUrl, `
  select release_state || '|' || version::text || '|' ||
    (select count(*) from public.community_comment_abuse_policies)::text || '|' ||
    (select count(*) from public.community_comment_threads)::text || '|' ||
    (select count(*) from public.community_comments)::text || '|' ||
    (select count(*) from public.community_comment_votes)::text || '|' ||
    (select count(*) from public.community_comment_vote_transitions)::text || '|' ||
    (select count(*) from public.community_comment_vote_requests)::text
  from public.community_comment_settings where singleton;
`);
if (state !== "off|1|0|0|0|0|0|0") {
  throw new Error("Comment Vote concurrency postflight found DEV state drift.");
}

console.log(JSON.stringify({
  result: "atomic_comment_vote_concurrency_ok",
  samePairTransactions: 2,
  independentVoterTransactions: 2,
  samePairMs: Math.round(samePairMs),
  independentMs: Math.round(independentMs),
  devState: state,
}));
