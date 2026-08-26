import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migrationPath =
  "supabase/migrations/20260826000900_warning_correction_auto_flag_visibility.sql";
const sql = readFileSync(migrationPath, "utf8");

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

test("existing exact Flag view boundary is upgraded without creating or copying grants", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["users.flag.view"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");
  assert.equal(definition.implementationVersion, 3);
  assert.equal(hash, definition.definitionHash);
  assert.match(sql, /where key = 'users\.flag\.view'/u);
  assert.match(sql, new RegExp(hash, "u"));
  assert.doesNotMatch(sql, /insert into public\.team_role_capabilities/iu);
  assert.doesNotMatch(sql, /delete from public\.team_role_capabilities/iu);
});

test("canonical Overrule RPC remains the sole mutation and its immutable event atomically produces one notification", () => {
  assert.doesNotMatch(sql, /create or replace function public\.overrule_user_warning/iu);
  assert.doesNotMatch(sql, /create function public\.overrule_user_warning/iu);
  const producer = sql.slice(
    sql.indexOf("create function public.produce_user_warning_overrule_notification"),
    sql.indexOf("create trigger user_warning_overrule_notification_after_insert"),
  );
  assert.match(producer, /enqueue_account_notification_event/u);
  assert.match(producer, /'user_warning_overruled:' \|\| new\.warning_id::text/u);
  assert.match(producer, /'user_warning_overruled'/u);
  assert.match(producer, /'account_warnings'/u);
  assert.match(producer, /'\/warnings\/' \|\| v_public_warning_id::text/u);
  assert.match(sql, /after insert on public\.user_warning_events[\s\S]*when \(new\.event_type = 'overruled'\)/u);
  assert.doesNotMatch(producer, /push_delivery_jobs|notification_broadcast_jobs/iu);
});

test("neutral correction notification is in-product only and exposes no Team or evidence detail", () => {
  assert.match(sql, /'user_warning_issued', 'user_warning_overruled'/u);
  assert.match(sql, /user_warning_overruled'[\s\S]*category_key = 'account_warnings'/u);
  assert.match(sql, /when 'user_warning_overruled' then 'Account Warning corrected'/u);
  assert.match(sql, /A Warning for your account was overruled\. Review its current effective status\./u);
  assert.match(sql, /when 'user_warning_overruled' then 'View warning'/u);
  const projection = sql.slice(
    sql.indexOf("create or replace function public.get_own_notifications"),
    sql.indexOf("alter function public.authorize_user_flag_capability"),
  );
  assert.doesNotMatch(
    projection,
    /issued_by|actor_display|correction_reason|source_comment|auto_flag/iu,
  );
});

test("Overrule target binding and automatic Flag reads use exact capability boundaries", () => {
  const targetRead = sql.slice(
    sql.indexOf("create function public.get_user_warning_overrule_target"),
    sql.indexOf("create function public.build_user_warning_auto_flag_case_payload"),
  );
  assert.match(targetRead, /authorize_user_warning_capability[\s\S]*users\.warnings\.overrule/u);
  assert.match(targetRead, /public_warning_id = p_public_warning_id/u);
  assert.match(targetRead, /target_discord_user_id = v_target_id/u);
  assert.doesNotMatch(targetRead, /reason|source_comment|actor_display|auto_flag/iu);

  const autoRead = sql.slice(
    sql.indexOf("create function public.build_user_warning_auto_flag_case_payload"),
    sql.indexOf("create or replace function public.get_own_notifications"),
  );
  assert.match(autoRead, /authorize_user_flag_capability[\s\S]*users\.flag\.view/u);
  assert.match(autoRead, /user_warning_auto_flag_cases/u);
  assert.match(autoRead, /user_warning_auto_flag_events/u);
  assert.match(autoRead, /event_type/u);
  assert.match(autoRead, /activeWarningCount/u);
  assert.match(autoRead, /triggeredByActiveCount/u);
  assert.match(autoRead, /triggeredByFourteenDay/u);
  assert.doesNotMatch(autoRead, /review_user_flag_case|ban_website_user|participation_hold/iu);
});

test("new read and producer functions are owner, path, overload and ACL hardened", () => {
  for (const signature of [
    "produce_user_warning_overrule_notification()",
    "get_user_warning_overrule_target(text,text,uuid)",
    "build_user_warning_auto_flag_case_payload(uuid)",
    "list_user_warning_auto_flag_cases(text,text,text,integer,integer)",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(sql, new RegExp(`alter function public\\.${escaped}\\s+owner to postgres`, "u"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}`, "u"));
  }
  assert.match(sql, /set search_path = public, pg_temp/gu);
  assert.match(sql, /grant execute on function public\.get_user_warning_overrule_target\(text,text,uuid\)[\s\S]*to service_role/u);
  assert.match(sql, /grant execute on function public\.list_user_warning_auto_flag_cases\(text,text,text,integer,integer\)[\s\S]*to service_role/u);
  assert.doesNotMatch(sql, /grant execute on function public\.build_user_warning_auto_flag_case_payload\(uuid\)[\s\S]*to service_role/u);
  assert.match(sql, /WARNING_CORRECTION_AUTO_FLAG_FUNCTION_HARDENING_MISMATCH/u);
});
