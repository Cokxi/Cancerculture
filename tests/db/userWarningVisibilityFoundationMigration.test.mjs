import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const path = "supabase/migrations/20260826000700_user_warning_visibility_foundation.sql";
const sql = readFileSync(path, "utf8");

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

test("Warning visibility installs one exact zero-grant read capability on the exact baseline", () => {
  const definition = TEAM_CAPABILITY_REGISTRY["users.warnings.view"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");
  assert.equal(hash, definition.definitionHash);
  assert.match(sql, /capability_catalog\) <> 51/u);
  assert.match(sql, /capability_catalog\) <> 52/u);
  assert.match(sql, /'users\.warnings\.view'/u);
  assert.match(sql, new RegExp(hash, "u"));
  assert.match(sql, /USER_WARNING_VISIBILITY_BASELINE_MISMATCH/u);
  assert.doesNotMatch(sql, /insert into public\.team_role_capabilities/iu);
});

test("Warning insert atomically produces exactly one required in-product-only notification", () => {
  assert.match(sql, /'account_warnings'[\s\S]*true,[\s\S]*true,[\s\S]*false,[\s\S]*false/u);
  assert.match(sql, /event_type = 'user_warning_issued' and category_key = 'account_warnings'/u);
  const producer = sql.slice(
    sql.indexOf("create function public.produce_user_warning_notification"),
    sql.indexOf("create trigger user_warning_notification_after_insert"),
  );
  assert.match(producer, /enqueue_account_notification_event/u);
  assert.match(producer, /'user_warning_issued:' \|\| new\.warning_id::text/u);
  assert.match(producer, /'\/warnings\/' \|\| new\.public_warning_id::text/u);
  assert.match(sql, /after insert on public\.user_warnings/u);
  assert.doesNotMatch(producer, /push_delivery_jobs|notification_broadcast_jobs/iu);
});

test("owner Warning detail exposes only the allowlisted neutral projection", () => {
  const detail = sql.slice(
    sql.indexOf("create function public.get_own_user_warning_detail"),
    sql.indexOf("create function public.get_user_warning_team_history"),
  );
  assert.match(detail, /require_account_session/u);
  assert.match(detail, /target_discord_user_id = v_owner_id/u);
  for (const key of [
    "warningId",
    "category",
    "reason",
    "issuedAt",
    "effectiveStatus",
    "expiresAt",
  ]) assert.match(detail, new RegExp(`'${key}'`, "u"));
  assert.doesNotMatch(
    detail,
    /issuedBy|actor|autoFlag|sourceComment|targetDiscord|recurrence|eventType/u,
  );
  assert.match(detail, /expires_at <= v_now[\s\S]*then 'expired'/u);
});

test("Team history is exact-capability guarded, bounded, source-bound and recalculation-visible", () => {
  const history = sql.slice(
    sql.indexOf("create function public.get_user_warning_team_history"),
    sql.indexOf("create function public.get_user_warning_team_summaries"),
  );
  assert.match(history, /authorize_user_warning_capability[\s\S]*users\.warnings\.view/u);
  assert.match(history, /limit 101/u);
  assert.match(history, /historyHasMore/u);
  assert.match(history, /sourceCommentObjectVersion/u);
  assert.match(history, /sourceCommentTextVersion/u);
  assert.match(history, /sourceCommentBody/u);
  assert.match(history, /originalTierDays/u);
  assert.match(history, /effectiveTierDays/u);
  assert.match(history, /user_warning_events/u);
  assert.doesNotMatch(history, /user_warning_auto_flag/iu);
});

test("generic Notification Center copy is redacted and Warning Push stays unavailable", () => {
  const notifications = sql.slice(
    sql.indexOf("create or replace function public.get_own_notifications"),
    sql.indexOf("alter function public.authorize_user_warning_capability"),
  );
  assert.match(notifications, /when 'user_warning_issued' then 'Account warning issued'/u);
  assert.match(notifications, /Review a Warning issued by the CancerCulture Team\./u);
  assert.match(notifications, /when 'user_warning_issued' then 'View warning'/u);
  assert.doesNotMatch(notifications, /warning_row\.reason|issued_by|actor|auto_flag/iu);
  assert.match(sql, /category_key = 'account_warnings'[\s\S]*not push_available/u);
});

test("all new RPCs are postgres-owned, fixed-path, overload-checked and service-only", () => {
  for (const signature of [
    "get_own_user_warning_detail(uuid,uuid)",
    "get_user_warning_team_history(text,text)",
    "get_user_warning_team_summaries(text,text[])",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(sql, new RegExp(`alter function public\\.${escaped} owner to postgres`, "u"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*to service_role`, "u"));
  }
  assert.match(sql, /set search_path = public, pg_temp/gu);
  assert.match(sql, /USER_WARNING_VISIBILITY_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(sql, /USER_WARNING_VISIBILITY_RLS_POLICY_MISMATCH/u);
});
