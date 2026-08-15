import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../supabase/migrations/20260815000200_final_prelaunch_application_data_factory_reset.sql",
  import.meta.url
);
const historicalUrl = new URL(
  "../../supabase/migrations/20260812000400_prelaunch_application_data_factory_reset.sql",
  import.meta.url
);
const [migration, historicalMigration] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(historicalUrl, "utf8"),
]);

function dispositionRows(source) {
  const block = source.match(
    /insert into factory_reset_disposition\(table_name, disposition\)\s*values(?<rows>.*?);/su
  )?.groups?.rows;
  assert.ok(block, "disposition block must exist");
  return [...block.matchAll(/\('([^']+)', '(preserve|subset|reset)'\)/gu)].map(
    ([, tableName, disposition]) => ({ tableName, disposition })
  );
}

const rows = dispositionRows(migration);
const byDisposition = (name) =>
  rows.filter((row) => row.disposition === name).map((row) => row.tableName);

test("new reset is additive and leaves the historical DEV reset byte-identical", () => {
  assert.equal(
    createHash("sha256").update(historicalMigration).digest("hex"),
    "aea0b5507c82ef792bc806db82dd928ee1ec133c481428565c405598f5423634"
  );
  assert.match(migrationUrl.pathname, /20260815000200_/u);
  assert.match(migration, /^begin;/u);
  assert.match(migration, /commit;\s*$/u);
  assert.doesNotMatch(migration, /20260812000400_prelaunch_application_data_factory_reset[.]sql/u);
});

test("all 78 current-schema base tables have one exact disposition", () => {
  assert.equal(rows.length, 78);
  assert.equal(new Set(rows.map((row) => row.tableName)).size, 78);
  assert.deepEqual(byDisposition("subset"), ["team_members", "user_logs"]);
  assert.equal(byDisposition("preserve").length, 15);
  assert.equal(byDisposition("reset").length, 61);

  for (const table of [
    "capability_catalog",
    "coin_launches",
    "content_documents",
    "content_publications",
    "content_revisions",
    "cycle_rule_templates",
    "cycle_scheduler_health",
    "cycle_vote_signal_policies",
    "cycle_vote_signal_policy_state",
    "discord_sync_health",
    "homepage_info_blocks",
    "rules_meta",
    "team_roles",
    "app_config",
    "next_cycle_config",
  ]) {
    assert.equal(
      rows.find((row) => row.tableName === table)?.disposition,
      "preserve",
      table
    );
  }

  for (const table of [
    "sponsor_tracking_aggregates",
    "sponsor_media_upload_operations",
    "submission_reports",
    "cycle_vote_observation_events",
    "discord_membership_sync_events",
    "vote_refund_events",
  ]) {
    assert.equal(
      rows.find((row) => row.tableName === table)?.disposition,
      "reset",
      table
    );
  }
});

test("catalog preflight is exact for 78 tables, five views and 20 sequences", () => {
  assert.match(migration, /cardinality\(v_expected_tables\) <> 78/u);
  assert.match(migration, /v_actual_tables is distinct from v_expected_tables/u);
  for (const view of [
    "public_submissions_with_votes",
    "submissions_with_votes",
    "user_logs_with_stats",
    "vote_refund_candidates",
    "vote_refund_submission_audit",
  ]) {
    assert.match(migration, new RegExp(`'${view}'`, "u"));
  }
  assert.match(migration, /pg_sequences where schemaname = 'public'\) <> 20/u);
  assert.match(
    migration,
    /to_regprocedure\('public[.]record_sponsor_event_v2\(bigint,text,text,text,text\)'\) is null/u
  );
  assert.doesNotMatch(
    migration,
    /record_sponsor_event_v2\(text,bigint,text,text,text\)/u
  );
  assert.match(migration, /FINAL_FACTORY_RESET_CURRENT_SCHEMA_CONTRACT_MISSING/u);
});

test("LIVE and rollback-only DEV targets are distinct and fail closed", () => {
  assert.match(migration, /nrxfuvsfezfqcwfmpxxl/u);
  assert.match(migration, /gceljiuydyiwkomymuqh/u);
  assert.match(migration, /FINAL_PRELAUNCH_LIVE_RESET_20260815_A1/u);
  assert.match(migration, /FINAL_PRELAUNCH_DEV_ROLLBACK_ONLY_20260815/u);
  assert.match(migration, /set local timezone = 'UTC'/u);
  assert.match(migration, /d1bf674e3693cd8eeb2112283ed2feee/u);
  assert.doesNotMatch(migration, /7f3f31d172f4d928ef01de221b7d6a1/u);
  for (const binding of [
    "backup_sha256",
    "backup_record_sha256",
    "media_manifest_sha256",
    "catalog_sha256",
    "data_sha256",
    "reference_sha256",
  ]) {
    assert.match(
      migration,
      new RegExp(`cancerculture\\.factory_reset_${binding}`, "u")
    );
  }
  assert.match(migration, /coalesce\(v_hash, ''\) !~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(migration, /FINAL_FACTORY_RESET_FINGERPRINT_BINDING_MISMATCH/u);
});

test("active upload, cleanup, scheduler, sync and transaction writers block reset", () => {
  assert.match(migration, /submission_upload_operations[\s\S]*?'reserved', 'r2_uploaded'/u);
  assert.match(migration, /sponsor_media_upload_operations[\s\S]*?status = 'reserved'/u);
  assert.match(migration, /media_cleanup_queue[\s\S]*?status <> 'completed'/u);
  assert.match(migration, /discord_reconciliation_snapshots[\s\S]*?status = 'collecting'/u);
  assert.match(migration, /cycle_scheduler_health[\s\S]*?active_run_id is not null/u);
  assert.match(migration, /pg_stat_activity[\s\S]*?backend_xid is not null/u);
  assert.match(migration, /FINAL_FACTORY_RESET_WRITERS_NOT_QUIESCENT/u);
});

test("reset uses one complete RESTRICT truncate and preserves internal sequences", () => {
  const truncate = migration.match(
    /truncate table(?<tables>[\s\S]*?)continue identity restrict;/u
  )?.groups?.tables;
  assert.ok(truncate);
  const truncatedTables = [...truncate.matchAll(/public[.]([a-z0-9_]+)/gu)].map(
    ([, tableName]) => tableName
  );
  assert.equal(truncatedTables.length, 63);
  assert.deepEqual(
    [...truncatedTables].sort(),
    [...byDisposition("reset"), ...byDisposition("subset")].sort()
  );
  assert.doesNotMatch(migration, /restart identity|\bcascade\b/iu);
  assert.doesNotMatch(migration, /session_replication_role|disable trigger/iu);
  assert.doesNotMatch(migration, /\bsetval\s*\(|alter sequence|restart with/iu);
  assert.match(migration, /FINAL_FACTORY_RESET_SEQUENCE_DRIFT/u);
});

test("preserve, security, overload and owner contracts are fingerprinted before and after", () => {
  for (const contract of [
    "relations",
    "columns",
    "constraints",
    "indexes",
    "triggers",
    "foreign_keys",
    "policies",
    "functions",
    "schema_acl",
  ]) {
    assert.match(migration, new RegExp(`'${contract}'`, "u"));
  }
  assert.match(migration, /oid::regprocedure::text/u);
  assert.match(migration, /pg_get_functiondef/u);
  assert.match(migration, /factory_reset_special_preserve_before/u);
  assert.match(migration, /FINAL_FACTORY_RESET_PRESERVED_DATA_DRIFT/u);
  assert.match(migration, /factory_reset_admin_fingerprint/u);
});

test("Sponsor, Next-Cycle and Admin activity are exactly neutralized", () => {
  for (const key of [
    "next_cycle_sponsor_feed_banner_r2_key",
    "next_cycle_sponsor_draft_revision",
    "next_cycle_sponsor_banner_r2_key",
    "next_cycle_sponsored_enabled",
  ]) {
    assert.match(migration, new RegExp(key, "u"));
  }
  assert.match(migration, /next_cycle_sponsor_draft_revision' then '0'/u);
  assert.match(migration, /first_seen_at = created_at/u);
  assert.match(migration, /last_seen_at = created_at/u);
  assert.match(migration, /avatar_key = null/u);
  assert.match(migration, /FINAL_FACTORY_RESET_NEUTRALITY_FAILED/u);
});

test("rollback-only mode ends in one unique expected sentinel", () => {
  const sentinel = "FINAL_FACTORY_RESET_ROLLBACK_ONLY_COMPLETE_20260815";
  assert.equal(migration.split(sentinel).length - 1, 1);
  assert.match(migration, /current_setting\('cancerculture[.]factory_reset_rollback_only', true\) = 'on'/u);
  assert.match(migration, /errcode = 'P0001'/u);
  assert.doesNotMatch(migration, /supabase_migrations|schema_migrations/u);
});
