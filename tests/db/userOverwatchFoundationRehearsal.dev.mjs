import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const psql = process.env.PSQL_BIN
  ?? "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const expectedMigrationSha256 =
  "08F5072663A792B1EB38E4445406FDF45599FD785226FC31419C6730381D9FD4";

function projectRef(value) {
  const parsed = new URL(value);
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
    throw new Error("Refusing to rehearse Overwatch outside DEV.");
  }
  return value;
}

const migrationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260827000100_user_overwatch_foundation.sql",
);
const contractPath = path.join(
  repoRoot,
  "tests",
  "db",
  "userOverwatchFoundation.dev.sql",
);
const migrationBuffer = await readFile(migrationPath);
const actualMigrationSha256 = createHash("sha256")
  .update(migrationBuffer)
  .digest("hex")
  .toUpperCase();
if (actualMigrationSha256 !== expectedMigrationSha256) {
  throw new Error("Refusing rehearsal because the Overwatch migration SHA-256 changed.");
}

const migration = migrationBuffer.toString("utf8").replace(/\bcommit;\s*$/u, "");
const contract = (await readFile(contractPath, "utf8"))
  .replace(/^\\set[^\r\n]*(?:\r?\n)+/u, "")
  .replace(/^begin;\s*/u, "")
  .replace(/\brollback;\s*$/u, "");
const rehearsal = `${migration}\n${contract}\nrollback;\n`;
const databaseUrl = await loadDevDatabaseUrl();
const result = spawnSync(
  psql,
  [databaseUrl, "-X", "-q", "--no-password", "-v", "ON_ERROR_STOP=1"],
  {
    cwd: repoRoot,
    windowsHide: true,
    encoding: "utf8",
    input: rehearsal,
    maxBuffer: 4 * 1024 * 1024,
  },
);

if (result.error || result.status !== 0) {
  const detail = String(result.stderr ?? "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
    .trim()
    .slice(0, 2000);
  throw new Error(
    `The sanitized DEV Overwatch rollback rehearsal failed.${detail ? `\n${detail}` : ""}`,
  );
}

console.log(
  `DEV Overwatch rollback rehearsal passed for ${expectedMigrationSha256}; all changes rolled back.`,
);
