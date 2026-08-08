import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260808000300_user_disqualification_history.sql",
    repoRoot
  ),
  "utf8"
);

function canonicalDefinition(definition) {
  return {
    key: definition.key,
    display_name: definition.displayName,
    description: definition.description,
    category: definition.category,
    included_actions: definition.includedActions,
    excluded_actions: definition.excludedActions,
    risk_level: definition.riskLevel,
    assignable_to_non_admin: definition.assignableToNonAdmin,
    implementation_version: definition.implementationVersion,
  };
}

test("the additive migration registers one exact high-risk zero-grant capability", () => {
  const definition =
    TEAM_CAPABILITY_REGISTRY["users.disqualified_submissions.view"];
  const definitionHash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");

  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.equal(definitionHash, definition.definitionHash);
  assert.match(migration, /'users\.disqualified_submissions\.view'/u);
  assert.match(migration, new RegExp(definitionHash, "u"));
  assert.match(migration, /'high',\s+true,\s+true,\s+1,/u);
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
  assert.match(
    migration,
    /exists\s*\([\s\S]*public\.team_role_capabilities[\s\S]*users\.disqualified_submissions\.view/u
  );
  assert.match(migration, /USER_DQ_HISTORY_CAPABILITY_FINAL_STATE_MISMATCH/u);
});

test("the per-submission ledger is append-only, private, and source-attributed", () => {
  assert.match(
    migration,
    /create table public\.submission_disqualification_events/u
  );
  assert.match(migration, /transition in \('disqualified', 'reinstated'\)/u);
  assert.match(migration, /provenance in \('complete', 'legacy_partial'\)/u);
  assert.match(migration, /moderation_log_id uuid unique/u);
  assert.match(
    migration,
    /enable row level security[\s\S]*revoke all on table public\.submission_disqualification_events\s+from public, anon, authenticated, discord_bot, service_role/u
  );
  assert.match(
    migration,
    /before update or delete on public\.submission_disqualification_events/u
  );
  assert.match(migration, /SUBMISSION_DISQUALIFICATION_EVENTS_APPEND_ONLY/u);
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete) on table public\.submission_disqualification_events/u
  );
});

test("canonical moderation and Discord-sync transitions are captured atomically", () => {
  assert.match(
    migration,
    /after insert on public\.moderation_action_logs[\s\S]*capture_submission_disqualification_log_event/u
  );
  assert.match(
    migration,
    /after update of is_disqualified on public\.submissions[\s\S]*new\.disqualification_type = 'discord_ban'/u
  );
  assert.match(
    migration,
    /v_submission\.cycle_id,\s+v_submission\.discord_user_id,/u
  );
  assert.match(
    migration,
    /submission\.cycle_id,\s+submission\.discord_user_id,/u
  );
  assert.doesNotMatch(
    migration,
    /coalesce\((?:new|log)\.target_discord_user_id/u
  );
});

test("legacy history remains explicitly partial and missing transitions are not fabricated", () => {
  assert.match(migration, /'current_state_backfill',\s+'legacy_partial'/u);
  assert.match(migration, /'legacy_log'/u);
  assert.match(
    migration,
    /where coalesce\(submission\.is_disqualified, false\)[\s\S]*is distinct from 'disqualified'/u
  );
  assert.doesNotMatch(
    migration,
    /generate_series|lead\s*\(|lag\s*\(|delete\s+from\s+public\.moderation_action_logs/iu
  );
});

test("raw cursor reads are bounded and callable only by the service role", () => {
  assert.match(migration, /p_limit not between 1 and 50/u);
  assert.match(
    migration,
    /\(grouped\.latest_event_at, grouped\.latest_event_id\)\s+< \(p_after_at, p_after_event_id\)/u
  );
  assert.match(
    migration,
    /\(grouped\.latest_event_at, user_log\.public_profile_id\)\s+< \(p_after_at, p_after_public_profile_id\)/u
  );
  assert.match(
    migration,
    /grant execute on function public\.get_user_disqualification_history\([\s\S]*to service_role/u
  );
  assert.match(
    migration,
    /grant execute on function public\.get_user_disqualification_profiles\([\s\S]*to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.get_user_disqualification_(?:history|profiles)\([\s\S]{0,180}to (?:anon|authenticated)/iu
  );
  assert.match(migration, /USER_DQ_HISTORY_READ_ACL_FINAL_STATE_MISMATCH/u);
});
