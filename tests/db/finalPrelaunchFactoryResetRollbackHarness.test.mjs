import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [harness, fingerprintSql] = await Promise.all([
  readFile(new URL("./finalPrelaunchFactoryResetRollback.dev.mjs", import.meta.url), "utf8"),
  readFile(new URL("./finalPrelaunchFactoryResetOutsideFingerprint.dev.sql", import.meta.url), "utf8"),
]);

test("rollback harness requires explicit DEV backup and media evidence", () => {
  for (const name of [
    "FINAL_FACTORY_RESET_DEV_BACKUP_SHA256",
    "FINAL_FACTORY_RESET_DEV_BACKUP_RECORD_SHA256",
    "FINAL_FACTORY_RESET_DEV_MEDIA_MANIFEST_SHA256",
  ]) {
    assert.match(harness, new RegExp(name, "u"));
  }
  assert.match(harness, /gceljiuydyiwkomymuqh/u);
  assert.doesNotMatch(harness, /nrxfuvsfezfqcwfmpxxl/u);
});

test("rollback harness accepts exactly one sentinel and rejects any other SQL error", () => {
  assert.match(harness, /FINAL_FACTORY_RESET_ROLLBACK_ONLY_COMPLETE_20260815/u);
  assert.match(harness, /split\(sentinel\)[.]length - 1, 1/u);
  assert.match(harness, /unexpectedErrors/u);
  assert.match(harness, /assert[.]deepEqual\(unexpectedErrors, \[\]\)/u);
});

test("outside fingerprints cover all data, catalog, sequences and migration ledger", () => {
  assert.match(fingerprintSql, /information_schema[.]tables/u);
  assert.match(fingerprintSql, /pg_get_functiondef/u);
  assert.match(fingerprintSql, /pg_policies/u);
  assert.match(fingerprintSql, /pg_sequences/u);
  assert.match(fingerprintSql, /supabase_migrations[.]schema_migrations/u);
  assert.match(fingerprintSql, /outside_sha256/u);
  assert.match(harness, /const before = readOutsideFingerprint\(\)/u);
  assert.match(harness, /const after = readOutsideFingerprint\(\)/u);
  assert.match(harness, /assert[.]deepEqual\(after, before/u);
});

test("harness forces read-only outside fingerprints and isolates the rollback transaction", () => {
  assert.match(harness, /default_transaction_read_only=on/u);
  assert.match(harness, /rollbackOnlyTransaction:\s*true/u);
  assert.match(fingerprintSql, /^begin read only;/mu);
  assert.match(fingerprintSql, /rollback;\s*$/u);
});
