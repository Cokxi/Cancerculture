import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [foundation, migration, simplification, devContract, server, workflowRoute, queue, navigation, navigationServer, shell] =
  await Promise.all([
    read("supabase/migrations/20260809000500_submission_report_team_workflow_foundation.sql"),
    read("supabase/migrations/20260809000600_submission_report_team_workflow_cutover.sql"),
    read("supabase/migrations/20260809000800_simplify_submission_report_release_workflow.sql"),
    read("tests/db/submissionReportTeamWorkflowCutover.dev.sql"),
    read("lib/reports/submissionReportTeam.server.ts"),
    read("app/api/admin/submission-reports/review/route.ts"),
    read("app/admin/reports/SubmissionReportQueueClient.tsx"),
    read("lib/admin/teamAreaNavigation.ts"),
    read("lib/admin/teamAreaNavigation.server.ts"),
    read("app/admin/TeamAreaShell.tsx"),
  ]);

test("the cutover deprecates the broad capability, activates five exact capabilities, and preserves zero grants", () => {
  assert.match(migration, /SUBMISSION_REPORT_TEAM_CUTOVER_CAPABILITY_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_TEAM_CUTOVER_CATALOG_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /count\(\*\) from public\.capability_catalog\) <> 38/u);
  assert.match(migration, /count\(\*\) from public\.capability_catalog where is_active\) <> 35/u);
  assert.match(migration, /where key = 'submissions\.reports\.view'/u);
  assert.match(migration, /is_active = false/u);
  for (const key of [
    "submissions.reports.live.view",
    "submissions.reports.finalized.view",
    "submissions.reports.assign",
    "logs.submission_reporters.view",
    "logs.submission_report_moderation.view",
  ]) {
    assert.match(migration, new RegExp(key.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.team_role_capabilities/iu
  );
});

test("assignment state and V1 retirement are fail-closed", () => {
  assert.match(migration, /submission_report_cases_assignment_state_check/u);
  assert.match(migration, /\(status = 'in_review'\) = \(assigned_to_discord_user_id is not null\)/u);
  assert.match(migration, /revoke execute on function public\.list_submission_report_cases\(text, integer\)[\s\S]*from service_role/u);
  assert.match(migration, /revoke execute on function public\.get_submission_report_case\(text, uuid\)[\s\S]*from service_role/u);
  assert.match(migration, /revoke execute on function public\.review_submission_report_case/u);
  assert.match(migration, /SUBMISSION_REPORT_TEAM_CUTOVER_FUNCTION_HARDENING_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_TEAM_CUTOVER_ENTRY_ACL_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_TEAM_CUTOVER_HELPER_ACL_MISMATCH/u);
  assert.match(migration, /aclexplode/u);
});

test("server reads enforce area, reporter-log, workflow-log, and review capabilities separately", () => {
  for (const capability of [
    "submissions.reports.live.view",
    "submissions.reports.finalized.view",
    "submissions.reports.review",
    "logs.submission_reporters.view",
    "logs.submission_report_moderation.view",
  ]) {
    assert.match(server, new RegExp(capability.replaceAll(".", "\\."), "u"));
  }
  assert.match(server, /list_submission_report_cases_v2/u);
  assert.match(server, /get_submission_report_case_summary_v2/u);
  assert.match(server, /get_submission_report_detail_v2/u);
  assert.match(server, /get_submission_report_unread_counts_v2/u);
  assert.match(server, /list_submission_report_outcome_events_v3/u);
  assert.match(server, /authorization\.isAdmin/u);
  assert.doesNotMatch(server, /submissions\.reports\.assign|list_submission_report_assignment_targets_v2/u);
  assert.doesNotMatch(server, /"submissions\.reports\.view"/u);
});

test("the only viewer-read mutation is the authorized full Report detail", () => {
  const detail = foundation.match(
    /create function public\.get_submission_report_detail_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  const list = migration.match(
    /create or replace function public\.list_submission_report_cases_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  const summary = migration.match(
    /create or replace function public\.get_submission_report_case_summary_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(detail, /insert into public\.submission_report_reads/u);
  assert.ok(
    detail.indexOf("authorize_submission_report_capability_v2") <
      detail.indexOf("insert into public.submission_report_reads")
  );
  assert.doesNotMatch(`${list}\n${summary}`, /insert into public\.submission_report_reads/u);
  assert.match(queue, /openReport/u);
  assert.match(queue, /View Report/u);
  assert.match(queue, /isRead: true/u);
  assert.doesNotMatch(queue, /Mark reports seen|acknowledge/u);
});

test("workflow API and UI expose only the four agreed concurrency-safe operations", () => {
  for (const operation of [
    "claim",
    "release",
    "forced_release",
    "close",
  ]) {
    assert.match(workflowRoute, new RegExp(`"${operation}"`, "u"));
    assert.match(queue, new RegExp(`"${operation}"`, "u"));
  }
  assert.match(workflowRoute, /expectedRowVersion/u);
  assert.match(workflowRoute, /expectedLatestReportId/u);
  assert.match(workflowRoute, /idempotencyKey/u);
  assert.match(workflowRoute, /note\.length < 10/u);
  assert.match(queue, /crypto\.randomUUID\(\)/u);
  assert.match(queue, /Return to queue/u);
  assert.match(queue, /Admin override release/u);
  assert.doesNotMatch(`${workflowRoute}\n${queue}`, /recover_claim|"reassign"|assignment-targets/u);
  assert.match(simplification, /v_operation not in \('claim', 'release', 'forced_release', 'close'\)/u);
  assert.match(simplification, /v_actor_role <> 'admin'/u);
});

test("queue/modal and categorized navigation are accessible and count individual unread Reports", () => {
  assert.match(queue, /aria-expanded/u);
  assert.match(queue, /aria-controls/u);
  assert.match(queue, /role="dialog"/u);
  assert.match(queue, /aria-modal="true"/u);
  assert.match(queue, /event\.key === "Escape"/u);
  assert.match(queue, /getSubmissionThumbnailUrl|thumbnailUrl/u);
  assert.match(navigation, /href: "\/admin\/reports\/live"/u);
  assert.match(navigation, /href: "\/admin\/reports\/finalized"/u);
  assert.match(navigationServer, /get_submission_report_unread_counts_v2|loadSubmissionReportUnreadCounts/u);
  assert.match(navigationServer, /counts\.live/u);
  assert.match(navigationServer, /counts\.finalized/u);
  assert.match(navigationServer, /counts\.total/u);
  assert.match(shell, /aria-expanded=\{open\}/u);
  assert.match(shell, /aria-controls=\{listId\}/u);
  assert.match(shell, /category\.badges/u);
});

test("the rollback-only DEV contract covers split reads, receipts, release workflow, redaction, and grant isolation", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_QUEUE_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_SUMMARY_READ_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_READ_RECEIPT_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_VOLUNTARY_RELEASE_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ADMIN_OVERRIDE_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_LEGACY_OPERATION_ACCEPTED/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_WORKFLOW_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_DELEGATED_REDACTION_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_LOG_GRANT_LEAKED_VIEW/u);
});
