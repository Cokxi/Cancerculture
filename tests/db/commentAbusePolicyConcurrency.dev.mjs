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
  const line = source.split(/\r?\n/u).find((candidate) => /^\s*SUPABASE_DEV_DATABASE_URL\s*=/u.test(candidate));
  const value = process.env.SUPABASE_DEV_DATABASE_URL
    ?? line?.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
  if (!value || projectRef(value) !== "gceljiuydyiwkomymuqh") {
    throw new Error("Refusing to run Comment policy concurrency outside DEV.");
  }
  return value;
}

function runSql(databaseUrl, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      cwd: repoRoot,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => reject(new Error("The DEV Comment policy concurrency command could not start.")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr.replaceAll(databaseUrl, "[DEV_DATABASE_URL]").replace(/\s+/gu, " ").trim().slice(0, 500);
      reject(new Error(`Sanitized Comment policy concurrency SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

function heldRow(sql) {
  return `begin; ${sql}; select pg_sleep(0.5); select 'locked'; rollback;`;
}

function heldAdvisory(key) {
  const safe = key.replaceAll("'", "''");
  return heldRow(`select pg_advisory_xact_lock(hashtextextended('${safe}',0))`);
}

async function timed(databaseUrl, statements) {
  const startedAt = performance.now();
  const results = await Promise.all(statements.map((sql) => runSql(databaseUrl, sql)));
  if (results.some((value) => !value.endsWith("locked"))) throw new Error("A Comment policy lock transaction did not complete.");
  return performance.now() - startedAt;
}

function assertSerialized(name, elapsed) {
  if (elapsed < 850 || elapsed > 8_000) throw new Error(`${name} did not serialize.`);
}

function assertIndependent(name, elapsed, serialized) {
  if (elapsed < 350 || elapsed > 3_000 || elapsed >= serialized - 250) {
    throw new Error(`${name} was unexpectedly globally serialized.`);
  }
}

const databaseUrl = await loadDevDatabaseUrl();
const sameReleaseMs = await timed(databaseUrl, [
  heldRow("select 1 from public.community_comment_settings where singleton for update"),
  heldRow("select 1 from public.community_comment_settings where singleton for update"),
]);
assertSerialized("Release-state mutations", sameReleaseMs);

const samePolicyMs = await timed(databaseUrl, [
  heldRow("select 1 from public.community_comment_abuse_policy_states where action='root' for update"),
  heldRow("select 1 from public.community_comment_abuse_policy_states where action='root' for update"),
]);
assertSerialized("Same-action policy mutations", samePolicyMs);

const independentPolicyMs = await timed(databaseUrl, [
  heldRow("select 1 from public.community_comment_abuse_policy_states where action='root' for update"),
  heldRow("select 1 from public.community_comment_abuse_policy_states where action='reply' for update"),
]);
assertIndependent("Independent action policies", independentPolicyMs, samePolicyMs);

const actor = `policy-concurrency-${randomUUID()}`;
const sameBudgetMs = await timed(databaseUrl, [
  heldAdvisory(`community-comment-abuse:${actor}:report`),
  heldAdvisory(`community-comment-abuse:${actor}:report`),
]);
assertSerialized("Same-user Report budgets", sameBudgetMs);

const independentBudgetMs = await timed(databaseUrl, [
  heldAdvisory(`community-comment-abuse:${randomUUID()}:report`),
  heldAdvisory(`community-comment-abuse:${randomUUID()}:report`),
]);
assertIndependent("Independent Report budgets", independentBudgetMs, sameBudgetMs);

const state = await runSql(databaseUrl, `
  select release_state || '|' ||
    (select count(*) from public.community_comment_abuse_policy_states where active_policy_version is not null)::text || '|' ||
    (select count(*) from public.community_comment_spam_policy_state where active_policy_version is not null)::text
  from public.community_comment_settings where singleton;
`);
if (state !== "off|0|0") throw new Error("Comment policy concurrency postflight found active DEV configuration.");

console.log(JSON.stringify({
  result: "comment_abuse_policy_concurrency_ok",
  sameReleaseMs: Math.round(sameReleaseMs),
  samePolicyMs: Math.round(samePolicyMs),
  independentPolicyMs: Math.round(independentPolicyMs),
  sameBudgetMs: Math.round(sameBudgetMs),
  independentBudgetMs: Math.round(independentBudgetMs),
  devState: state,
}));
