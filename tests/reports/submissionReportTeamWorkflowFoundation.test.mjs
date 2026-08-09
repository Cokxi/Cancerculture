import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260809000500_submission_report_team_workflow_foundation.sql",
    root
  ),
  "utf8"
);
const devContract = await readFile(
  new URL("tests/db/submissionReportTeamWorkflowFoundation.dev.sql", root),
  "utf8"
);

const stagedKeys = [
  "submissions.reports.live.view",
  "submissions.reports.finalized.view",
  "submissions.reports.assign",
  "logs.submission_reporters.view",
  "logs.submission_report_moderation.view",
];

function canonical(definition) {
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

test("the five exact capabilities are staged with canonical hashes and zero-grant activation safety", () => {
  assert.equal(stagedKeys.length, 5);
  for (const key of stagedKeys) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const hash = createHash("sha256")
      .update(JSON.stringify(canonical(definition)), "utf8")
      .digest("hex");
    assert.equal(definition.lifecycle, "staged");
    assert.equal(definition.assignableToNonAdmin, false);
    assert.equal(definition.riskLevel, "high");
    assert.equal(definition.definitionHash, hash);
    assert.match(migration, new RegExp(`'${key.replaceAll(".", "\\.")}'`, "u"));
    assert.match(migration, new RegExp(hash, "u"));
  }
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 33/u);
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 38/u);
  assert.match(migration, /not is_active and not assignable_to_non_admin/u);
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.team_role_capabilities/iu
  );
  assert.doesNotMatch(
    migration,
    /update public\.capability_catalog[\s\S]*submissions\.reports\.view/iu
  );
});

test("the additive schema preserves facts and separates assignment from viewer reads", () => {
  assert.match(migration, /add column assigned_to_discord_user_id text/u);
  assert.match(migration, /add column assigned_to_display_name text/u);
  assert.match(migration, /add column assigned_at timestamptz/u);
  assert.match(migration, /submission_report_cases_assignment_check/u);
  assert.match(migration, /create table public\.submission_report_reads/u);
  assert.match(migration, /primary key \(viewer_discord_user_id, report_id\)/u);
  assert.match(migration, /enable row level security/u);
  assert.match(
    migration,
    /revoke all on table public\.submission_report_reads[\s\S]*service_role/u
  );
  assert.doesNotMatch(migration, /drop table|delete from public\.submission_report/iu);
  assert.match(migration, /v_preflight\.report_count <>/u);
  assert.match(migration, /v_preflight\.event_count <>/u);
  assert.match(migration, /exists \(select 1 from public\.submission_report_reads\)/u);
});

test("Live and Finalized lists expose bounded summaries without Report free text", () => {
  const list = migration.match(
    /create function public\.list_submission_report_cases_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  const summary = migration.match(
    /create function public\.get_submission_report_case_summary_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(list, /p_area not in \('live', 'finalized'\)/u);
  assert.match(list, /report_count desc, latest_report_at desc, case_id/u);
  assert.match(list, /'unreadReportCount'/u);
  assert.match(list, /'thumbnailAvailable'/u);
  assert.match(summary, /'reasonCode'/u);
  assert.match(summary, /'subcategoryCode'/u);
  assert.match(summary, /'isRead'/u);
  assert.match(summary, /'uploaderLabel'/u);
  assert.doesNotMatch(`${list}\n${summary}`, /reporter_comment|reporterLabel|publicProfileId/u);
});

test("a full authorized detail atomically and idempotently creates the viewer receipt", () => {
  const detail = migration.match(
    /create function public\.get_submission_report_detail_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(detail, /authorize_submission_report_capability_v2/u);
  assert.match(detail, /insert into public\.submission_report_reads/u);
  assert.match(
    detail,
    /on conflict \(viewer_discord_user_id, report_id\) do nothing/u
  );
  assert.ok(
    detail.indexOf("authorize_submission_report_capability_v2") <
      detail.indexOf("insert into public.submission_report_reads")
  );
  assert.match(detail, /'comment', payload\.reporter_comment/u);
  assert.match(detail, /'reporterLabel'/u);
});

test("unread counts are per viewer and a Report stays read when its area changes", () => {
  const unread = migration.match(
    /create function public\.get_submission_report_unread_counts_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(unread, /viewer_discord_user_id = btrim\(p_actor_discord_user_id\)/u);
  assert.match(unread, /submission_report_case_area\(report\.case_id\) = 'live'/u);
  assert.match(unread, /submission_report_case_area\(report\.case_id\) = 'finalized'/u);
  assert.match(unread, /'total', v_live \+ v_finalized/u);
  assert.doesNotMatch(
    migration,
    /primary key \(viewer_discord_user_id, report_id, read_area\)/u
  );
});

test("exclusive claim mutations serialize idempotency and Case state", () => {
  const workflow = migration.match(
    /create function public\.manage_submission_report_case_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(workflow, /pg_advisory_xact_lock/u);
  assert.match(workflow, /where case_id = p_case_id for update/u);
  assert.match(workflow, /v_case\.row_version <> p_expected_row_version/u);
  assert.match(workflow, /v_case\.latest_report_id <> p_expected_latest_report_id/u);
  assert.match(workflow, /SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT/u);
  assert.match(workflow, /SUBMISSION_REPORT_STALE/u);
  assert.match(workflow, /SUBMISSION_REPORT_NOT_ASSIGNEE/u);
  assert.match(workflow, /SUBMISSION_REPORT_TARGET_INELIGIBLE/u);
  assert.match(workflow, /SUBMISSION_REPORT_RECOVERY_FORBIDDEN/u);
  assert.match(workflow, /nullif\(v_operation, ''\) is null/u);
  assert.match(workflow, /v_expected_status is null/u);
  assert.match(workflow, /v_disposition is null or v_disposition not in/u);
  assert.match(workflow, /submissions\.reports\.assign/u);
  assert.match(workflow, /else 'submissions\.reports\.review' end/u);
  assert.match(workflow, /case_claimed/u);
  assert.match(workflow, /case_released/u);
  assert.match(workflow, /case_claim_recovered/u);
  assert.match(workflow, /case_forced_released/u);
  assert.match(workflow, /case_reassigned/u);
  assert.match(workflow, /insert into public\.submission_report_case_events/u);
});

test("the rollback-only DEV contract covers read receipts, claims, replay, stale state, reassignment, and close", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_READ_RECEIPT_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_CLAIM_REPLAY_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_INVALID_ACCEPTED/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_STALE_ACCEPTED/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_REASSIGN_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_DEV_CLOSE_MISMATCH/u);
});

test("all new functions are hardened and only intended entry RPCs reach service_role", () => {
  assert.match(migration, /FUNCTION_HARDENING_MISMATCH/u);
  assert.match(migration, /ENTRY_ACL_MISMATCH/u);
  assert.match(migration, /HELPER_ACL_MISMATCH/u);
  assert.match(migration, /aclexplode/u);
  assert.match(migration, /function_row\.prosecdef/u);
  assert.match(migration, /function_row\.proowner/u);
  assert.match(migration, /search_path=public, pg_temp/u);
  for (const fn of [
    "list_submission_report_cases_v2",
    "get_submission_report_case_summary_v2",
    "get_submission_report_detail_v2",
    "get_submission_report_unread_counts_v2",
    "manage_submission_report_case_v2",
  ]) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}`, "u"));
  }
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.(?:submission_report_case_area|has_submission_report_capability_v2|authorize_submission_report_capability_v2)[\s\S]*to service_role/iu
  );
});
