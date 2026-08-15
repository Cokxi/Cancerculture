import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationPath = fileURLToPath(
  new URL(
    "../../supabase/migrations/20260815000200_final_prelaunch_application_data_factory_reset.sql",
    import.meta.url
  )
);
const fingerprintPath = fileURLToPath(
  new URL("./finalPrelaunchFactoryResetOutsideFingerprint.dev.sql", import.meta.url)
);
const connection = process.env.SUPABASE_DEV_DATABASE_URL;
const psql = process.env.PSQL_BIN ?? "psql";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MD5_PATTERN = /^[0-9a-f]{32}$/u;

if (!connection) {
  throw new Error("SUPABASE_DEV_DATABASE_URL is required");
}

function requiredSha(name) {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} is required`);
  return value;
}

function runPsql(args, { rollbackOnlyTransaction = false } = {}) {
  const result = spawnSync(psql, [connection, "-X", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PGOPTIONS: rollbackOnlyTransaction
        ? "-c default_transaction_read_only=off"
        : "-c default_transaction_read_only=on",
      PGCONNECT_TIMEOUT: "10",
    },
  });
  if (result.error) throw result.error;
  return result;
}

function readOutsideFingerprint() {
  const result = runPsql(["--no-align", "--tuples-only", "--file", fingerprintPath]);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find((value) => value.split("|").length === 7);
  assert.ok(line, "complete outside fingerprint row is required");
  const [outside, catalog, data, reference, sequence, ledger, owner] = line.split("|");
  for (const value of [outside, catalog, data, reference, sequence, ledger]) {
    assert.match(value, SHA256_PATTERN);
  }
  assert.match(owner, MD5_PATTERN);
  return { outside, catalog, data, reference, sequence, ledger, owner };
}

const backupSha256 = requiredSha("FINAL_FACTORY_RESET_DEV_BACKUP_SHA256");
const backupRecordSha256 = requiredSha(
  "FINAL_FACTORY_RESET_DEV_BACKUP_RECORD_SHA256"
);
const mediaManifestSha256 = requiredSha(
  "FINAL_FACTORY_RESET_DEV_MEDIA_MANIFEST_SHA256"
);
const before = readOutsideFingerprint();
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "cancerculture-final-reset-")
);

try {
  const wrapperPath = path.join(temporaryDirectory, "rollback-only.sql");
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const wrapper = [
    "\\set ON_ERROR_STOP on",
    `select set_config('cancerculture.factory_reset_target_project_ref', ${literal("gceljiuydyiwkomymuqh")}, false);`,
    `select set_config('cancerculture.factory_reset_confirmation', ${literal("FINAL_PRELAUNCH_DEV_ROLLBACK_ONLY_20260815")}, false);`,
    `select set_config('cancerculture.factory_reset_owner_anchor_fingerprint', ${literal(before.owner)}, false);`,
    `select set_config('cancerculture.factory_reset_backup_sha256', ${literal(backupSha256)}, false);`,
    `select set_config('cancerculture.factory_reset_backup_record_sha256', ${literal(backupRecordSha256)}, false);`,
    `select set_config('cancerculture.factory_reset_media_manifest_sha256', ${literal(mediaManifestSha256)}, false);`,
    `select set_config('cancerculture.factory_reset_catalog_sha256', ${literal(before.catalog)}, false);`,
    `select set_config('cancerculture.factory_reset_data_sha256', ${literal(before.data)}, false);`,
    `select set_config('cancerculture.factory_reset_reference_sha256', ${literal(before.reference)}, false);`,
    "select set_config('cancerculture.factory_reset_rollback_only', 'on', false);",
    "\\set ON_ERROR_STOP off",
    `\\ir ${migrationPath.replaceAll("\\", "/")}`,
    "\\set ON_ERROR_STOP on",
  ].join("\n");
  await writeFile(wrapperPath, wrapper, { encoding: "utf8", mode: 0o600 });

  const result = runPsql(["--file", wrapperPath], {
    rollbackOnlyTransaction: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const sentinel = "FINAL_FACTORY_RESET_ROLLBACK_ONLY_COMPLETE_20260815";
  assert.equal(combinedOutput.split(sentinel).length - 1, 1, combinedOutput);
  const unexpectedErrors = combinedOutput
    .split(/\r?\n/u)
    .filter((line) => /ERROR:/u.test(line) && !line.includes(sentinel));
  assert.deepEqual(unexpectedErrors, []);

  const after = readOutsideFingerprint();
  assert.deepEqual(after, before, "rollback must preserve data, schema, sequences and ledger");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
