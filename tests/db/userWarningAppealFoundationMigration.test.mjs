import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migration = await readFile(new URL(
  "../../supabase/migrations/20260827000200_user_warning_appeal_foundation.sql",
  import.meta.url,
), "utf8");

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

test("Warning Appeal capabilities are exact, active, and zero-grant", () => {
  for (const key of ["users.warning_appeals.view", "users.warning_appeals.review"]) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
      .digest("hex");
    assert.equal(definition.definitionHash, hash);
    assert.equal(definition.lifecycle, "active");
    assert.match(migration, new RegExp(hash, "u"));
  }
  assert.match(migration, /capability_catalog\) <> 54/u);
  assert.match(migration, /capability_catalog\) <> 56/u);
  assert.match(migration, /USER_WARNING_APPEAL_UNEXPECTED_GRANT|team_role_capabilities[\s\S]*users\.warning_appeals\.view/u);
});

test("one immutable Appeal domain and one dedicated Team Inbox topic are created", () => {
  for (const relation of [
    "user_warning_appeals",
    "user_warning_appeal_current",
    "user_warning_appeal_events",
    "user_warning_appeal_requests",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${relation}`, "u"));
    assert.match(migration, new RegExp(`alter table public\\.${relation} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${relation}`, "u"));
  }
  assert.match(migration, /warning_id uuid not null unique/u);
  assert.match(migration, /char_length\(appeal_text\) between 20 and 1000/u);
  assert.match(migration, /USER_WARNING_APPEAL_HISTORY_IS_APPEND_ONLY/u);
  assert.match(migration, /USER_WARNING_APPEAL_CURRENT_TRANSITION_FORBIDDEN/u);
  assert.match(migration, /'warning_appeals', 'Warning Appeals', true/u);
  assert.match(migration, /array\['users\.warning_appeals\.view', 'users\.warning_appeals\.review'\]/u);
});

test("submission is owner-bound, once-only, idempotent, and has no Warning side effect", () => {
  const submit = migration.match(/create function public\.submit_user_warning_appeal\([\s\S]*?\n\$function\$;/u)?.[0] ?? "";
  assert.match(submit, /require_account_session\(p_session_id\)/u);
  assert.match(submit, /target_discord_user_id = v_owner_id/u);
  assert.match(submit, /USER_WARNING_APPEAL_WARNING_WITHDRAWN/u);
  assert.match(submit, /USER_WARNING_APPEAL_ALREADY_SUBMITTED/u);
  assert.match(submit, /user-warning-appeal-request:/u);
  assert.match(submit, /jsonb_set\(v_existing\.receipt, '\{replayed\}'/u);
  assert.match(submit, /upsert_team_inbox_case/u);
  assert.doesNotMatch(submit, /update public\.user_warning_current/u);
  assert.doesNotMatch(submit, /insert into public\.user_warning_events/u);
});

test("review has an assigned expected-version winner and canonical Overrule", () => {
  const review = migration.match(/create function public\.review_user_warning_appeal\([\s\S]*?\n\$function\$;/u)?.[0] ?? "";
  assert.match(review, /p_expected_case_row_version bigint/u);
  assert.match(review, /p_expected_case_work_version bigint/u);
  assert.match(review, /p_expected_case_source_version bigint/u);
  assert.match(review, /p_expected_appeal_row_version bigint/u);
  assert.match(review, /p_expected_warning_row_version bigint/u);
  assert.match(review, /assignee_discord_user_id <> v_actor_id/u);
  assert.match(review, /authorize_user_warning_capability\(v_actor_id, 'users\.warnings\.overrule'\)/u);
  assert.match(review, /perform public\.overrule_user_warning\(/u);
  assert.match(review, /solve_team_inbox_case/u);
  assert.match(review, /user_warning_appeal_upheld:/u);
  assert.doesNotMatch(review, /insert into public\.user_warning_events/u);
  assert.match(migration, /after insert on public\.user_warning_events[\s\S]*new\.event_type = 'overruled'/u);
  assert.match(migration, /USER_WARNING_APPEAL_CASE_RETURN_GUARD/u);
});

test("Uphold notification is generic in-product only and Overrule is not duplicated", () => {
  assert.match(migration, /'user_warning_appeal_upheld'[\s\S]*category_key = 'account_warnings'/u);
  assert.match(migration, /CancerCulture Team reviewed your Warning appeal\. Open CancerCulture to view the outcome\./u);
  assert.match(migration, /when 'user_warning_appeal_upheld' then 'View outcome'/u);
  const sync = migration.match(/create function public\.sync_user_warning_appeal_overrule\(\)[\s\S]*?\n\$function\$;/u)?.[0] ?? "";
  assert.doesNotMatch(sync, /enqueue_account_notification_event/u);
});

test("only hardened outer Appeal functions are service-role executable", () => {
  for (const signature of [
    "submit_user_warning_appeal(uuid,uuid,text,uuid)",
    "get_own_user_warning_appeal_status(uuid,uuid)",
    "get_user_warning_appeal_case_detail(text,uuid)",
    "mutate_user_warning_appeal_case(text,uuid,uuid,text,text,bigint,bigint,text)",
    "review_user_warning_appeal(text,uuid,text,bigint,bigint,bigint,bigint,bigint,text,uuid)",
  ]) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature.replaceAll("(", "\\(").replaceAll(")", "\\)")}[\\s\\S]*to service_role`, "u"));
  }
  assert.doesNotMatch(migration, /grant execute on function public\.sync_user_warning_appeal_overrule\(\)[\s\S]*to service_role/u);
  assert.doesNotMatch(migration, /grant execute on function public\.assert_team_inbox_topic_access[\s\S]*to service_role/u);
});
