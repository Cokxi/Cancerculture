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
    throw new Error("Refusing to run Comment concurrency outside DEV.");
  }
  return value;
}

function runSql(databaseUrl, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => reject(new Error("The DEV concurrency command could not start.")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr
        .replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500);
      reject(new Error(`Sanitized Comment DEV concurrency SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

async function assertSerialized(databaseUrl, statements, label) {
  const startedAt = performance.now();
  const results = await Promise.all(statements.map((statement) => runSql(databaseUrl, statement)));
  const elapsedMs = performance.now() - startedAt;
  if (results.some((result) => !result.endsWith("locked"))) {
    throw new Error(`${label} did not complete both transactions.`);
  }
  if (elapsedMs < 850 || elapsedMs > 8_000) {
    throw new Error(`${label} did not serialize in the expected bounded window.`);
  }
  return Math.round(elapsedMs);
}

const databaseUrl = await loadDevDatabaseUrl();
const actor = `comment-concurrency-${randomUUID()}`;
const requestId = randomUUID();
const lockKey = `community-comment-request:${actor}:${requestId}`.replaceAll("'", "''");

const requestLockSql = `
  begin;
  select pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
  select pg_sleep(0.5);
  select 'locked';
  rollback;
`;
const requestLockMs = await assertSerialized(
  databaseUrl,
  [requestLockSql, requestLockSql],
  "Comment request advisory lock"
);

const rowLockSql = `
  begin;
  select singleton from public.community_comment_settings where singleton for update;
  select pg_sleep(0.5);
  select 'locked';
  rollback;
`;
const rowLockMs = await assertSerialized(
  databaseUrl,
  [rowLockSql, rowLockSql],
  "Comment row lock"
);

const state = await runSql(
  databaseUrl,
  `select release_state || '|' ||
    (select count(*) from public.community_comment_abuse_policies)::text || '|' ||
    (select count(*) from public.community_comment_threads)::text || '|' ||
    (select count(*) from public.community_comments)::text
   from public.community_comment_settings where singleton;`
);
if (state !== "off|0|0|0") {
  throw new Error("Comment concurrency postflight found DEV state drift.");
}

console.log(JSON.stringify({
  result: "comment_text_domain_concurrency_ok",
  requestLockTransactions: 2,
  rowLockTransactions: 2,
  requestLockMs,
  rowLockMs,
  devState: "off|0|0|0",
}));
