import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, authorizationFix, registry, server, route, queue, devContract] = await Promise.all([
  read("supabase/migrations/20260809000800_simplify_submission_report_release_workflow.sql"),
  read("supabase/migrations/20260809000900_fix_submission_report_review_authorization_v3.sql"),
  read("lib/auth/teamCapabilityRegistry.ts"),
  read("lib/reports/submissionReportTeam.server.ts"),
  read("app/api/admin/submission-reports/review/route.ts"),
  read("app/admin/reports/SubmissionReportQueueClient.tsx"),
  read("tests/db/submissionReportTeamWorkflowCutover.dev.sql"),
]);

test("the additive migration deprecates direct assignment without changing grants or report facts", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_CAPABILITY_MISMATCH/u);
  assert.match(migration, /SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_DATA_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /where key = 'submissions\.reports\.assign'[\s\S]*is_active = false/u);
  assert.match(migration, /assignable_to_non_admin = false/u);
  assert.match(migration, /implementation_version = 2/u);
  assert.match(migration, /7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6/u);
  assert.doesNotMatch(
    migration,
    /(?:insert into|update|delete from) public\.team_role_capabilities/iu
  );
});

test("the database workflow allows only Claim, voluntary return, Admin override, and Close", () => {
  const workflow = migration.match(
    /create or replace function public\.manage_submission_report_case_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.match(workflow, /v_operation not in \('claim', 'release', 'forced_release', 'close'\)/u);
  assert.match(workflow, /v_operation in \('forced_release', 'close'\)[\s\S]*char_length\(v_note\) not between 10 and 1000/u);
  assert.match(workflow, /v_operation in \('claim', 'release'\) and v_note is not null/u);
  assert.match(workflow, /v_operation = 'forced_release' and v_actor_role <> 'admin'/u);
  assert.match(workflow, /v_case\.assigned_to_discord_user_id is distinct from v_actor_id/u);
  assert.doesNotMatch(workflow, /recover_claim|'reassign'|submissions\.reports\.assign/u);
  assert.match(migration, /revoke execute on function public\.list_submission_report_assignment_targets_v2\([\s\S]*from service_role/u);
});

test("the additive authorization correction accepts Review V3 and never authorizes the legacy Assign tombstone", () => {
  assert.match(authorizationFix, /^begin;\s/u);
  assert.match(authorizationFix, /SUBMISSION_REPORT_REVIEW_AUTH_V3_BASELINE_MISMATCH/u);
  assert.match(authorizationFix, /when 'submissions\.reports\.review' then '490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a'/u);
  assert.match(authorizationFix, /when 'submissions\.reports\.review' then 3/u);
  const authorization = authorizationFix.match(
    /create or replace function public\.has_submission_report_capability_v2\([\s\S]*?\$function\$;/u
  )?.[0] ?? "";
  assert.doesNotMatch(authorization, /submissions\.reports\.assign/u);
  assert.match(authorizationFix, /revoke all on function public\.has_submission_report_capability_v2\(text, text\)[\s\S]*service_role/u);
  assert.match(authorizationFix, /SUBMISSION_REPORT_REVIEW_AUTH_V3_DATA_POSTFLIGHT_MISMATCH/u);
});

test("the application exposes the simplified workflow and derives override authority from Admin", () => {
  for (const operation of ["claim", "release", "forced_release", "close"]) {
    assert.match(route, new RegExp(`"${operation}"`, "u"));
    assert.match(queue, new RegExp(`"${operation}"`, "u"));
  }
  assert.match(server, /input\.operation === "forced_release" && !authorization\.isAdmin/u);
  assert.match(server, /canOverrideRelease: authorization\.isAdmin/u);
  assert.match(queue, /Return to queue/u);
  assert.match(queue, /Admin override release/u);
  assert.match(queue, /disabled=\{pending\}[\s\S]*Return to queue/u);
  assert.match(queue, /disabled=\{pending \|\| !noteReady\}[\s\S]*Admin override release/u);
  assert.doesNotMatch(`${server}\n${route}\n${queue}`, /recover_claim|"reassign"|assignment-targets/u);
  assert.match(registry, /submissions\.reports\.assign[\s\S]*lifecycle: "deprecated"/u);
});

test("the rollback-only DEV contract proves both release paths and rejects legacy operations", () => {
  assert.match(devContract, /^\\set ON_ERROR_STOP on\s+\s*begin;/u);
  assert.match(devContract, /rollback;\s*$/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_VOLUNTARY_RELEASE_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ADMIN_OVERRIDE_MISMATCH/u);
  assert.match(devContract, /SUBMISSION_REPORT_TEAM_CUTOVER_DEV_LEGACY_OPERATION_ACCEPTED/u);
  assert.match(devContract, /event_type = 'case_released'[\s\S]*note is null/u);
  assert.match(devContract, /event_type = 'case_forced_released'[\s\S]*Admin override because the original reviewer is unavailable/u);
});
