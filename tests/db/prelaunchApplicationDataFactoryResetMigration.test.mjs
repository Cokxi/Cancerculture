import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260812000400_prelaunch_application_data_factory_reset.sql",
    import.meta.url
  ),
  "utf8"
);
const devPostflight = await readFile(
  new URL(
    "./prelaunchApplicationDataFactoryResetPostflight.dev.sql",
    import.meta.url
  ),
  "utf8"
);
const preservedFingerprint = await readFile(
  new URL(
    "./prelaunchApplicationDataFactoryResetPreservedFingerprint.inc.sql",
    import.meta.url
  ),
  "utf8"
);

test("factory reset is a confirmation-gated transactional data migration", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(
    migration,
    /current_setting\(\s*'cancerculture\.factory_reset_confirmation', true\s*\)/u
  );
  assert.match(
    migration,
    /PRELAUNCH_APPLICATION_DATA_RESET_20260812/u
  );
  assert.match(
    migration,
    /coalesce\(v_backup_sha256, ''\) !~ '\^\[0-9a-f\]\{64\}\$'/u
  );
  assert.match(
    migration,
    /coalesce\(v_media_manifest_sha256, ''\) !~ '\^\[0-9a-f\]\{64\}\$'/u
  );
  assert.match(migration, /FACTORY_RESET_WRITERS_NOT_QUIESCENT/u);
});

test("factory reset removes the complete application-data graph without resetting identities", () => {
  for (const table of [
    "voting_cycles",
    "cycle_events",
    "cycle_results",
    "submissions",
    "submission_upload_operations",
    "votes",
    "winner_public_profiles",
    "vote_refund_events",
    "submission_reports",
    "submission_report_cases",
    "submission_report_case_events",
    "submission_disqualification_events",
    "moderation_action_logs",
    "user_flag_cases",
    "website_ban_events",
    "sponsor_tracking_events",
    "discord_reconciliation_snapshots",
    "team_authorization_audit",
    "user_logs",
    "team_members",
    "sessions",
    "media_cleanup_queue",
  ]) {
    assert.match(migration, new RegExp(`public\\.${table}`, "u"));
  }
  assert.match(migration, /continue identity restrict;/u);
  assert.doesNotMatch(migration, /restart identity|\bcascade\b/iu);
  assert.match(migration, /factory_reset_sequence_state/u);
  assert.match(migration, /FACTORY_RESET_SEQUENCE_POSTFLIGHT_FAILED/u);
});

test("canonical admin identity and owner membership survive with test activity scrubbed", () => {
  assert.match(migration, /factory_reset_admin_user/u);
  assert.match(migration, /factory_reset_admin_member/u);
  assert.match(migration, /where member\.role = 'admin'/u);
  assert.match(migration, /insert into public\.user_logs/u);
  assert.match(migration, /insert into public\.team_members/u);
  assert.match(migration, /flagged_for_review = false/u);
  assert.match(migration, /is_banned = false/u);
  assert.match(migration, /accepted_rules_version = null/u);
  assert.match(migration, /avatar_key = null/u);
  assert.match(migration, /first_seen_at = created_at/u);
  assert.match(migration, /last_seen_at = created_at/u);
  assert.match(migration, /show_socials = false/u);
  assert.match(migration, /website_ban_version = 0/u);

  const adminScrub = migration.slice(
    migration.indexOf("update public.user_logs"),
    migration.indexOf("insert into public.team_members")
  );
  assert.doesNotMatch(adminScrub, /public_profile_id\s*=/u);
  assert.doesNotMatch(adminScrub, /^\s*discord_user_id\s*=/mu);
  assert.match(migration, /FACTORY_RESET_CANONICAL_ADMIN_PREFLIGHT_FAILED/u);
});

test("schema, security, content, settings and operational health stay intact", () => {
  for (const table of [
    "capability_catalog",
    "team_roles",
    "content_documents",
    "content_revisions",
    "content_publications",
    "homepage_info_blocks",
    "rules_meta",
    "cycle_vote_signal_policies",
    "cycle_vote_signal_policy_state",
    "cycle_scheduler_health",
    "discord_sync_health",
  ]) {
    assert.match(
      migration,
      new RegExp(`'${table}'`, "u"),
      `${table} must be fingerprinted as preserved data`
    );
  }
  assert.match(migration, /factory_reset_contract_fingerprints/u);
  assert.match(migration, /pg_policies/u);
  assert.match(migration, /pg_get_triggerdef/u);
  assert.match(
    migration,
    /FACTORY_RESET_SECURITY_CONTRACT_POSTFLIGHT_FAILED/u
  );
  assert.doesNotMatch(
    migration,
    /(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:function|view|index|policy|trigger|type|sequence)\b/iu
  );
  assert.doesNotMatch(migration, /create\s+table\s+public\./iu);
});

test("sponsor instances are neutralized while non-sponsor configuration is fingerprinted", () => {
  assert.match(migration, /app_config_non_sponsor/u);
  assert.match(migration, /next_cycle_config_non_sponsor/u);
  assert.match(migration, /next_cycle_is_sponsored/u);
  assert.match(migration, /next_cycle_sponsor_banner_r2_key/u);
  assert.match(migration, /is_sponsored = false/u);
  assert.match(migration, /sponsor_banner_key = null/u);
  assert.match(migration, /sponsor_tracking_events/u);
  assert.match(migration, /cycle_sponsorships/u);
});

test("public numbering restarts through the unchanged max-plus-one allocator", () => {
  assert.match(
    migration,
    /public\.assign_voting_cycle_public_number\(\)/u
  );
  assert.match(migration, /voting_cycles_assign_public_number/u);
  assert.match(migration, /exists \(select 1 from public\.voting_cycles\)/u);
  assert.doesNotMatch(migration, /setval|alter sequence|restart with/iu);
  assert.match(devPostflight, /v_cycle_number <> 1/u);
  assert.match(devPostflight, /rollback;\s*$/u);
  assert.doesNotMatch(devPostflight, /setval|alter sequence|restart with/iu);
});

test("DEV postflight proves normal session recreation and the empty launch baseline", () => {
  assert.match(
    devPostflight,
    /public\.create_cancerculture_session\(\s*gen_random_uuid\(\),\s*v_admin_discord_user_id\s*\)/u
  );
  assert.match(devPostflight, /FACTORY_RESET_ADMIN_RELOGIN_CONTRACT_FAILED/u);
  assert.match(devPostflight, /FACTORY_RESET_APPLICATION_DATA_NOT_EMPTY/u);
  assert.match(devPostflight, /FACTORY_RESET_PRESERVED_CONFIGURATION_MISMATCH/u);
  assert.match(
    devPostflight,
    /FACTORY_RESET_PRESERVED_CONTENT_FINGERPRINT_MISMATCH/u
  );
  assert.match(devPostflight, /expected_preserved_fingerprint_md5/u);
  assert.match(preservedFingerprint, /query_to_xml/u);
});
